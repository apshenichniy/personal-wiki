import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { discoverOwnerProvider } from "../../apps/knowledge-service/src/access/oidc.ts";

export const ownerSettings = {
  publicOrigin: "https://wiki.example.test",
  issuer: "https://id.example.test",
  ownerSubject: "synthetic-owner",
  clientId: "synthetic-reader",
  clientSecret: "synthetic-confidential-secret",
  signingAlgorithm: "RS256" as const,
};
export type InvalidIdentity =
  | "non-owner"
  | "issuer"
  | "audience"
  | "azp"
  | "nonce"
  | "expired"
  | "signature"
  | "pkce"
  | "missing-token";

/** A controlled OIDC peer signs real JWTs; openid-client still performs all
 * discovery, code exchange, PKCE and signature/claim validation. No live auth. */
export async function ownerProviderFixture() {
  const key = await generateKeyPair("RS256");
  const wrong = await generateKeyPair("RS256");
  const publicKey = {
    ...(await exportJWK(key.publicKey)),
    kid: "fixture-key",
    use: "sig",
    alg: "RS256",
  };
  const codes = new Map<string, { url: URL; invalid?: InvalidIdentity }>();
  let discoveryMismatch = false;
  let exchanges = 0;
  const transport: NonNullable<Parameters<typeof discoverOwnerProvider>[1]> = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== ownerSettings.issuer) throw new Error("Unexpected fixture destination");
    if (parsed.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer: discoveryMismatch ? "https://wrong.example.test" : ownerSettings.issuer,
        authorization_endpoint: `${ownerSettings.issuer}/authorize`,
        token_endpoint: `${ownerSettings.issuer}/token`,
        jwks_uri: `${ownerSettings.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        authorization_response_iss_parameter_supported: true,
      });
    if (parsed.pathname === "/jwks") return Response.json({ keys: [publicKey] });
    if (parsed.pathname !== "/token")
      return Response.json({ error: "invalid_request" }, { status: 400 });
    exchanges++;
    if (!(init.body instanceof URLSearchParams)) throw new Error("Expected form body");
    const body = init.body;
    const code = body.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code);
    const challenge = createHash("sha256")
      .update(body.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      !grant ||
      body.get("client_id") !== ownerSettings.clientId ||
      body.get("client_secret") !== ownerSettings.clientSecret ||
      body.get("redirect_uri") !== `${ownerSettings.publicOrigin}/auth/callback` ||
      grant.url.searchParams.get("code_challenge") !== challenge ||
      grant.invalid === "pkce"
    )
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (grant.invalid === "missing-token")
      return Response.json({ token_type: "Bearer", access_token: "synthetic-access" });
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      nonce: grant.invalid === "nonce" ? "wrong" : grant.url.searchParams.get("nonce"),
      ...(grant.invalid === "azp" ? { aud: [ownerSettings.clientId, "other"], azp: "other" } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .setIssuer(grant.invalid === "issuer" ? "https://wrong.example.test" : ownerSettings.issuer)
      .setSubject(grant.invalid === "non-owner" ? "synthetic-stranger" : ownerSettings.ownerSubject)
      .setAudience(
        grant.invalid === "audience"
          ? "wrong-client"
          : grant.invalid === "azp"
            ? [ownerSettings.clientId, "other"]
            : ownerSettings.clientId,
      )
      .setIssuedAt(now)
      .setExpirationTime(grant.invalid === "expired" ? now - 120 : now + 300)
      .sign(grant.invalid === "signature" ? wrong.privateKey : key.privateKey);
    return Response.json({
      token_type: "Bearer",
      access_token: "synthetic-access",
      id_token: idToken,
    });
  };
  return {
    transport,
    get exchanges() {
      return exchanges;
    },
    mismatchDiscovery() {
      discoveryMismatch = true;
    },
    callback(authorization: string, invalid?: InvalidIdentity) {
      const url = new URL(authorization);
      const code = randomUUID();
      codes.set(code, { url, ...(invalid ? { invalid } : {}) });
      const callback = new URL(`${ownerSettings.publicOrigin}/auth/callback`);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("iss", ownerSettings.issuer);
      return callback;
    },
  };
}
