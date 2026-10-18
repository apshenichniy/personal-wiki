import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { WikiApi } from "@personal-wiki/contracts";

export const makeClient = (baseUrl: string) =>
  HttpApiClient.make(WikiApi, { baseUrl }).pipe(Effect.provide(FetchHttpClient.layer));
