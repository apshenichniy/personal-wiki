import { digest, invalid } from "./io.ts";

export type PageOptions = { cursor?: string | undefined; limit?: number | undefined };
/** Cursors carry no authorization. They bind one query/order/page size to one
 * applied projection; forged offsets cannot change that projection's contents. */
export function readPage(query: string, options: PageOptions, revision?: string) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw invalid("Use 1–100 results per page.");
  const binding = digest(
    JSON.stringify({ query, order: query.trim() ? "rank-v1" : "recent-v1", limit }),
  );
  let offset = 0;
  let pinned = revision;
  if (options.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(options.cursor)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        !("binding" in value) ||
        value.binding !== binding ||
        !("revision" in value) ||
        typeof value.revision !== "string" ||
        !/^[a-f0-9]{40}$/.test(value.revision) ||
        !("offset" in value) ||
        typeof value.offset !== "number" ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 1 ||
        (revision !== undefined && revision !== value.revision)
      )
        throw new Error();
      offset = value.offset;
      pinned = value.revision;
    } catch {
      throw invalid("Pagination cursor does not match this search.");
    }
  }
  return {
    limit,
    offset,
    revision: pinned,
    finish<A>(results: A[], appliedRevision: string) {
      return {
        appliedRevision,
        results: results.slice(offset, offset + limit),
        nextCursor:
          offset + limit < results.length
            ? Buffer.from(
                JSON.stringify({ binding, revision: appliedRevision, offset: offset + limit }),
              ).toString("base64url")
            : null,
      };
    },
  };
}
