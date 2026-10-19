import * as oidc from "openid-client";
import type { AccessConfiguration } from "./config.ts";

export type LoginProof = { state: string; nonce: string; verifier: string };

/** OIDC performs protocol and cryptographic verification. The application only
 * compares the resulting stable identity with its deliberately configured owner. */
export async function discoverOwnerProvider(
  settings: AccessConfiguration,
  transport?: oidc.CustomFetch,
) {
  const config = await oidc.discovery(
    new URL(settings.issuer),
    settings.clientId,
    {
      client_secret: settings.clientSecret,
      id_token_signed_response_alg: settings.signingAlgorithm,
      [oidc.clockTolerance]: 0,
    },
    undefined,
    {
      timeout: 10,
      execute: [oidc.enableNonRepudiationChecks],
      ...(transport ? { [oidc.customFetch]: transport } : {}),
    },
  );
  if (config.serverMetadata().issuer !== settings.issuer)
    throw new Error("OIDC discovery issuer differs.");
  const callback = `${settings.publicOrigin}/auth/callback`;
  return {
    async begin(proof: LoginProof) {
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: callback,
        scope: "openid",
        response_type: "code",
        state: proof.state,
        nonce: proof.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(proof.verifier),
        code_challenge_method: "S256",
      }).href;
    },
    async complete(url: URL, proof: LoginProof) {
      if (url.origin + url.pathname !== callback) throw new Error("Unexpected callback");
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: proof.verifier,
        expectedState: proof.state,
        expectedNonce: proof.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== "string") throw new Error("Missing identity");
      return { issuer: claims.iss, subject: claims.sub };
    },
  };
}
export type OwnerProvider = Awaited<ReturnType<typeof discoverOwnerProvider>>;
