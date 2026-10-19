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
