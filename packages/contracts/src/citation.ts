/** Durable Markdown link-title identity; the external destination stays unchanged. */
const prefix = "wiki-citation:";
export const citationTitle = (citationId: string) => `${prefix}${citationId}`;
export const citationFromTitle = (title: string | null | undefined) =>
  title?.startsWith(prefix) ? title.slice(prefix.length) : undefined;
