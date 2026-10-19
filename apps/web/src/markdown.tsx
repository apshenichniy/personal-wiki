import { citationFromTitle } from "@personal-wiki/contracts/citation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import type { Citation } from "@personal-wiki/contracts/knowledge";
type SourceCitation = typeof Citation.Type;
export function safeExternal(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function External({ href, children }: { href?: string | undefined; children: ReactNode }) {
  const safe = safeExternal(href);
  return safe ? (
    <a href={safe} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}
export function SafeMarkdown({
  text,
  citations = [],
  onSource,
}: {
  text: string;
  citations?: readonly SourceCitation[];
  onSource?: (citation: SourceCitation) => void;
}) {
  return (
    <div className="prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => safeExternal(url) ?? ""}
        components={{
          a: ({ href, title, children }) => {
            const matches = citations.filter((c) => c.canonicalUrl === href);
            const citationId = citationFromTitle(title);
            const pinned =
              citationId !== undefined
                ? matches.filter((c) => c.citationId === citationId)
                : matches;
            // Legacy Markdown may not identify one of multiple captures. Show
            // every candidate explicitly rather than silently choosing latest.
            const ambiguous = citationId === undefined && pinned.length > 1;
            return (
              <>
                <External href={href}>{children}</External>
                {onSource &&
                  pinned.map((citation) => (
                    <button
                      key={citation.citationId}
                      className="citation-source"
                      data-capture-id={citation.captureId}
                      aria-label={`${ambiguous ? "Возможный" : "Сохранённый"} источник: захват ${citation.captureId}, пост ${citation.providerId}`}
                      onClick={() => onSource(citation)}
                    >
                      {ambiguous ? "возможный захват" : "захват"} {citation.captureId.slice(0, 8)}
                    </button>
                  ))}
              </>
            );
          },
          img: ({ src, alt }) => (
            <External href={typeof src === "string" ? src : undefined}>
              Медиа: {alt || "открыть источник"}
            </External>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
