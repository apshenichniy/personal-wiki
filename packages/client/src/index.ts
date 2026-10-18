import { WorkflowApi } from "@personal-wiki/contracts/jobs-api";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { WikiApi } from "@personal-wiki/contracts";

export const makeClient = (baseUrl: string, token?: string) =>
  HttpApiClient.make(WikiApi, {
    baseUrl,
    transformClient: (client) =>
      token
        ? HttpClient.mapRequest(
            client,
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          )
        : client,
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const makeJobClient = (baseUrl: string, token: string) =>
  HttpApiClient.make(WorkflowApi, {
    baseUrl,
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer));
