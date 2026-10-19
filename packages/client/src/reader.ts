import { ReaderApi } from "@personal-wiki/contracts/reader-api";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
/** Same-origin owner cookies are supplied by the browser. No machine token is
 * accepted here. The CSRF getter follows session rotation without rebuilding. */
export const makeReaderClient = (baseUrl: string, csrf: () => string) =>
  HttpApiClient.make(ReaderApi, {
    baseUrl,
    transformClient: (client) =>
      HttpClient.mapRequest(client, (request) =>
        HttpClientRequest.setHeader(request, "x-csrf-token", csrf()),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer));
