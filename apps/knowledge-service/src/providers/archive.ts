import { Context, Effect, Layer, Schema } from "effect";
import * as P from "@personal-wiki/contracts/provider";
import { ProviderRawUpload } from "@personal-wiki/contracts/provider-api";
import { ProviderLedger } from "./ledger.ts";
import { RawArchive } from "../storage/raw-archive.ts";
import { digest } from "../storage/io.ts";

const invalid = (message: string) => new P.ProviderError({ code: "invalid_request", message });
const idFor = (value: string) => {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
export const rawObject = (namespace: typeof P.Namespace.Type, page: P.Page) => ({
  key: `providers/${namespace}/${page.operationId}/${page.assetId}.json`,
  sha256: page.sha256,
  byteLength: page.byteLength,
});
const Run = Schema.Struct({
  data: Schema.Struct({
    id: P.Name,
    buildId: P.Name,
    defaultDatasetId: P.Name,
    defaultKeyValueStoreId: P.Name,
    status: P.RunStatus,
  }),
});
const make = Effect.gen(function* () {
  const ledger = yield* ProviderLedger;
  const archive = yield* RawArchive;
  const retain = Effect.fn("Provider.archiveRaw")(function* (value: typeof ProviderRawUpload.Type) {
    const input = yield* Schema.decodeUnknownEffect(ProviderRawUpload)(value);
    const operation = yield* ledger.get(input.operationId);
    if (!operation.run || !P.terminal(operation.status))
      return yield* invalid("Only terminal known provider results can be archived.");
    const bytes = Buffer.from(input.base64, "base64");
    if (
      bytes.length < 1 ||
      bytes.length > 16_777_216 ||
      bytes.toString("base64") !== input.base64 ||
      digest(bytes) !== input.sha256
    )
      return yield* invalid("Raw page bytes or checksum are invalid.");
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      catch: () => invalid("Raw evidence must be valid UTF-8 JSON."),
    });
    let itemCount = 0;
    if (input.kind === "dataset") {
      if (
        !Array.isArray(parsed) ||
        parsed.length > 100 ||
        input.offset > input.total ||
        input.total > 10_000 ||
        input.offset + parsed.length > input.total ||
        (!parsed.length && input.offset < input.total)
      )
        return yield* invalid("Dataset page pagination is inconsistent.");
      itemCount = parsed.length;
    } else {
      if (input.offset !== 0 || input.total !== 0)
        return yield* invalid("Metadata has no dataset pagination.");
      if (input.kind === "run") {
        const run = (yield* Schema.decodeUnknownEffect(Run)(parsed)).data;
        if (
          run.id !== operation.run.runId ||
          run.buildId !== operation.run.buildId ||
          run.defaultDatasetId !== operation.run.datasetId ||
          run.defaultKeyValueStoreId !== operation.run.keyValueStoreId ||
          run.status !== operation.status
        )
          return yield* invalid("Archived run does not match the terminal operation.");
      }
    }
    const pageKey =
      input.kind === "dataset" ? `dataset:${input.offset}:${input.total}` : input.kind;
    const prior = yield* ledger.pageIntents(operation.operationId);
    if (
      input.kind === "dataset" &&
      prior.some((page) => {
        const parts = page.pageKey.split(":");
        return parts[0] === "dataset" && Number(parts[2]) !== input.total;
      })
    )
      return yield* invalid("Terminal dataset total changed during retention.");
    const page: P.Page = {
      operationId: operation.operationId,
      pageKey,
      assetId: idFor(`${operation.operationId}/${pageKey}`),
      sha256: input.sha256,
      byteLength: bytes.length,
      offset: input.offset,
      itemCount,
    };
    yield* ledger.reservePage(page);
    // No SQL transaction remains open while R2 is contacted.
    yield* archive.retain(rawObject(operation.job.namespace, page), bytes);
    return yield* ledger.retainPage(page);
  });
  const read = Effect.fn("Provider.readRaw")(function* (operationId: string, pageKey: string) {
    const op = yield* ledger.get(operationId);
    const page = (yield* ledger.pages(operationId)).find((entry) => entry.pageKey === pageKey);
    if (!page)
      return yield* new P.ProviderError({ code: "not_found", message: "Retained page not found." });
    const bytes = yield* archive.read(rawObject(op.job.namespace, page));
    return { page, base64: bytes.toString("base64") };
  });
  const complete = Effect.fn("Provider.completeArchive")(function* (operationId: string) {
    const op = yield* ledger.get(operationId);
    const pages = yield* ledger.pages(operationId);
    const data = pages
      .filter((page) => page.pageKey.startsWith("dataset:"))
      .sort((a, b) => a.offset - b.offset);
    if (!P.terminal(op.status) || !pages.some((page) => page.pageKey === "run") || !data.length)
      return yield* invalid("Terminal run metadata and dataset evidence are required.");
    let offset = 0;
    const total = Number(data[0]!.pageKey.split(":")[2]);
    for (const page of data) {
      if (page.offset !== offset || Number(page.pageKey.split(":")[2]) !== total)
        return yield* invalid("Retained dataset pages have a gap or overlap.");
      offset += page.itemCount;
    }
    if (offset !== total) return yield* invalid("Dataset retention is incomplete.");
    for (const page of pages) yield* archive.read(rawObject(op.job.namespace, page));
    return yield* ledger.archived(operationId);
  });
  return { retain, read, complete };
});
export class ProviderArchive extends Context.Service<
  ProviderArchive,
  Effect.Success<typeof make>
>()("personal-wiki/ProviderArchive") {
  static layer = Layer.effect(ProviderArchive, make);
}
