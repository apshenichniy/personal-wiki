import * as Processing from "@personal-wiki/contracts/processing";
import * as Provider from "@personal-wiki/contracts/provider";
import * as ProviderApi from "@personal-wiki/contracts/provider-api";
import { WorkflowApi } from "@personal-wiki/contracts/jobs-api";
import * as Jobs from "@personal-wiki/contracts/jobs";
import * as Knowledge from "@personal-wiki/contracts/knowledge";
import { mkdir } from "node:fs/promises";
import { Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { EchoRequest, EchoResponse, ErrorEnvelope, WikiApi } from "@personal-wiki/contracts";

const documents = new Map<string, unknown>([
  ["openapi.json", OpenApi.fromApi(WikiApi)],
  ["jobs-openapi.json", OpenApi.fromApi(WorkflowApi)],
]);
for (const [name, schema] of Object.entries({
  EchoRequest,
  EchoResponse,
  ErrorEnvelope,
  ...Knowledge,
  ...Jobs,
  ...Processing,
  ...Object.fromEntries(
    Object.entries(Provider)
      .filter(([, value]) => Schema.isSchema(value))
      .map(([key, value]) => [`Provider${key}`, value]),
  ),
  ...Object.fromEntries(Object.entries(ProviderApi).filter(([, value]) => Schema.isSchema(value))),
})) {
  if (!Schema.isSchema(schema)) continue;
  const document = Schema.toJsonSchemaDocument(schema);
  documents.set(`${name}.json`, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  });
}
await mkdir("packages/contracts/generated", { recursive: true });
for (const [name, document] of documents) {
  const path = `packages/contracts/generated/${name}`;
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (!(await Bun.file(path).exists()) || (await Bun.file(path).text()) !== contents) {
      throw new Error(`Stale contract: ${path}. Run bun run contracts.`);
    }
  } else {
    await Bun.write(path, contents);
  }
}
