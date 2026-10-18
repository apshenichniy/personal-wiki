import { Schema } from "effect";
import { PreparedSource } from "@personal-wiki/contracts/processing";
import { input, numberedThread, poolDriver, runFixture } from "../tests/fixtures/x/scenarios.ts";

const result = await runFixture(input("101"), poolDriver(numberedThread));
const serialized = JSON.stringify(result, null, 2);
Schema.decodeUnknownSync(Schema.fromJsonString(PreparedSource))(serialized);
// This command emits only redistributable synthetic fixtures, never live data.
process.stdout.write(`${serialized}\n`);
