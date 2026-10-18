import { Schema } from "effect";
import { ProviderId } from "@personal-wiki/contracts/knowledge";

const Targets = Schema.Array(ProviderId).check(Schema.isMinLength(1), Schema.isMaxLength(30));
/** The tested profile is deliberately narrower than the Actor's complete input
 * schema: no arbitrary search, URL, transform, proxy, field omission or mode. */
export const ActorInput = Schema.Struct({
  mode: Schema.Literals(["tweets", "thread", "search", "replies", "article"]),
  tweetIds: Schema.optional(Targets),
  threadTweetIds: Schema.optional(Targets),
  conversationIds: Schema.optional(Targets),
  replyTweetIds: Schema.optional(Targets),
  articleTweetIds: Schema.optional(Targets),
  maxItems: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  maxItemsPerTarget: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  queryType: Schema.Literal("Latest"),
  outputVariant: Schema.Literal("raw"),
  outputPreset: Schema.Literal("nested"),
  alwaysSaveRunRecords: Schema.Literal(true),
});
const fields = {
  tweets: "tweetIds",
  thread: "threadTweetIds",
  search: "conversationIds",
  replies: "replyTweetIds",
  article: "articleTweetIds",
} as const;
export function admitActorInput(json: string) {
  if (Buffer.byteLength(json) > 65_536) throw new Error("Input capacity exceeded");
  const input: unknown = JSON.parse(json);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(ActorInput.fields, key))
  )
    throw new Error("Unsupported Actor option");
  const value = Schema.decodeUnknownSync(ActorInput)(input);
  const selected = fields[value.mode];
  if (
    Object.values(fields).some((key) => key !== selected && value[key] !== undefined) ||
    !value[selected]?.length
  )
    throw new Error("Mode and targets disagree");
  if (
    new Set(value[selected]).size !== value[selected]!.length ||
    value.maxItems > value[selected]!.length * value.maxItemsPerTarget ||
    value.maxItemsPerTarget > value.maxItems
  )
    throw new Error("Target allocation is inconsistent");
  return value;
}
