import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown, safeExternal } from "./markdown.tsx";
test("the reading subset escapes source markup and never auto-loads media", () => {
  const html = renderToStaticMarkup(
    <SafeMarkdown
      text={
        "<script>alert(1)</script>\n\n![pixel](https://tracker.invalid/pixel)\n\n[x](javascript:alert(1))\n\n[good](https://x.com/i/status/12345)\n\n```js\n<script>\n```\n\n| A | B |\n| - | - |\n| x | y |"
      }
    />,
  );
  expect(html).not.toMatch(/<(script|img|iframe|svg)\b/);
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<table>");
  expect(html).toContain("noopener noreferrer");
  for (const url of ["//x.com", "data:text/html,x", "file:///tmp/x", "https://user:secret@x.com/"])
    expect(safeExternal(url)).toBeUndefined();
});

test("inline citations distinguish two retained versions of the same external post", () => {
  const url = "https://x.com/i/status/12345";
  const citations = ["old-capture", "new-capture"].map((captureId) => ({
    citationId: `${captureId}:12345`,
    captureId,
    sourceId: "source",
    providerId: "12345",
    canonicalUrl: url,
  }));
  const html = renderToStaticMarkup(
    <SafeMarkdown
      text={`Old [source](${url} "wiki-citation:old-capture:12345"). New [source](${url} "wiki-citation:new-capture:12345").`}
      citations={citations}
      onSource={() => {}}
    />,
  );
  expect(html.match(/data-capture-id="old-capture"/g)).toHaveLength(1);
  expect(html.match(/data-capture-id="new-capture"/g)).toHaveLength(1);
  expect(html.match(/href="https:\/\/x.com\/i\/status\/12345"/g)).toHaveLength(2);
  expect(html.indexOf('data-capture-id="old-capture"')).toBeLessThan(
    html.indexOf('data-capture-id="new-capture"'),
  );
  const legacy = renderToStaticMarkup(
    <SafeMarkdown text={`[source](${url})`} citations={citations} onSource={() => {}} />,
  );
  expect(legacy.match(/Возможный источник/g)).toHaveLength(2);
  const forged = renderToStaticMarkup(
    <SafeMarkdown
      text={`[source](${url} "wiki-citation:unknown")`}
      citations={citations}
      onSource={() => {}}
    />,
  );
  expect(forged).not.toContain("data-capture-id");
});
