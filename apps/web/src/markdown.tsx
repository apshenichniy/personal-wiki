import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
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
export function SafeMarkdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => safeExternal(url) ?? ""}
        components={{
          a: ({ href, children }) => <External href={href}>{children}</External>,
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
