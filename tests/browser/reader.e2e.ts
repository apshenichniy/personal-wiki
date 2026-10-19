import { test, expect, type Page } from "@playwright/test";
const login = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Библиотека", exact: true })).toBeVisible();
};
const postUrl = () =>
  `https://fxtwitter.com/example/status/${Date.now()}${Math.floor(Math.random() * 1000)}`;

test("save, lost response retry, progress, Russian reading, original search, downloads and explicit refresh", async ({
  page,
  context,
}, info) => {
  const outside: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("https://127.0.0.1:4173")) outside.push(request.url());
  });
  await login(page);
  const keys: string[] = [];
  await page.route("**/api/v1/submissions", async (route) => {
    keys.push((route.request().postDataJSON() as { requestId: string }).requestId);
    const response = await route.fetch();
    if (keys.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await page.getByLabel("Сохранить из X").fill(postUrl());
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Повторная отправка");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\/[a-f0-9-]+$/);
  expect(keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect(page.getByRole("heading", { name: "В очереди", exact: true })).toBeVisible();
  const jobUrl = page.url();
  await expect(page.getByRole("button", { name: "Остановить задание" })).toBeVisible();
  const completed = await context.request.post("/__test/run");
  expect(completed.ok(), await completed.text()).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Готово", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Сохранённый захват" }).first()).toBeVisible();
  await page.getByRole("link", { name: "Читать заметку" }).click();
  await expect(
    page.getByRole("heading", { name: "Надёжная публикация", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".prose")).toContainText("Транзакционная публикация");
  const citation = page.locator(".prose a").first();
  expect(await citation.getAttribute("href")).toMatch(/^https:\/\/x.com\/i\/status\/[0-9]+$/);
  await expect(citation).toHaveAttribute("rel", "noopener noreferrer");
  await page.screenshot({
    path: `.scratch/browser-results/${info.project.name}-reader.png`,
    fullPage: true,
  });
  const noteUrl = page.url();
  await page.getByRole("link", { name: "Архитектура виджетов →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Архитектура виджетов", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сохранённый оригинал", exact: true }).click();
  await expect(page.locator(".source-text")).toContainText("Efficient widget architecture");
  await page.getByRole("link", { name: "Надёжная публикация →", exact: true }).click();
  await expect(page).toHaveURL(noteUrl);
  await page.getByRole("button", { name: "Сохранённый оригинал", exact: true }).click();
  await expect(page.locator(".source-text")).toContainText("Flibbertigibbet");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Скачать сохранённый файл" }).click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe("retained-source.bin");
  await page.getByRole("link", { name: "← Библиотека" }).click();
  await page.getByLabel("Поиск в заметках и оригиналах").fill("Flibbertigibbet");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(page.locator(".note-list")).toContainText("Совпадение в оригинале · en");
  await page.locator(".note-list a").first().click();
  await expect(
    page.getByRole("button", { name: "Сохранённый оригинал", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".selected-source")).toContainText("Flibbertigibbet");
  await page.goto(noteUrl);
  await page.getByRole("button", { name: "Обновить источник…" }).click();
  await expect(page.getByText("Получить свежий захват", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Получить новый захват" }).click();
  await expect(page).toHaveURL(/\/jobs\/[a-f0-9-]+$/);
  expect(page.url()).not.toBe(jobUrl);
  // Leave no queued fixture work for the following test/project.
  await page.getByRole("button", { name: "Остановить задание" }).click();
  await expect(page.getByRole("heading", { name: "Отменено", exact: true })).toBeVisible();
  expect(outside).toEqual([]);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});

test("revocation on foreground hides private content and logout clears another tab", async ({
  page,
  context,
}) => {
  await login(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { name: "Библиотека", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ваша библиотека" })).toBeVisible();
  await expect(second.getByRole("heading", { name: "Ваша библиотека" })).toBeVisible();
  await page.getByRole("link", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Библиотека", exact: true })).toBeVisible();
  expect((await context.request.post("/__test/revoke")).status()).toBe(204);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  await expect(page.getByRole("heading", { name: "Ваша библиотека" })).toBeVisible();
  await expect(page.locator(".note-list")).toHaveCount(0);
  const denied = await context.request.get("/api/v1/notes", {
    headers: { "if-none-match": "*", range: "bytes=0-10" },
  });
  expect(denied.status()).toBe(401);
  expect(denied.headers()["cache-control"]).toBe("private, no-store");
  const shell = await context.request.get("/notes/00000000-0000-4000-8000-000000000001", {
    headers: { accept: "text/html" },
  });
  expect(shell.status()).toBe(401);
  expect(await shell.text()).not.toContain("Надёжная");
  await second.close();
});

test("unsafe source markup stays inert and late search responses cannot replace a newer query", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/v1/search", async (route) => {
    const query = (route.request().postDataJSON() as { query: string }).query;
    if (query === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fulfill({
        json: { appliedRevision: "a".repeat(40), results: [], nextCursor: null },
      });
      return;
    }
    await route.continue();
  });
  await page.getByLabel("Поиск в заметках и оригиналах").fill("slow");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await page.getByLabel("Поиск в заметках и оригиналах").fill("Flibbertigibbet");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(page.locator(".note-list a").first()).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.locator(".note-list a").first()).toBeVisible();
  await page.route("**/api/v1/notes/*", async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { note: { markdown: string } };
    data.note.markdown =
      '<script>window.evil=1</script>\n\n![tracker](https://tracker.invalid/pixel)\n\n[unsafe](javascript:alert(1))\n\n[good](https://x.com/i/status/12345)\n\n| Key | Value |\n| --- | --- |\n| Code | safe |\n\n```js\nconst x = "<script>";\n```';
    await route.fulfill({ response, json: data });
  });
  await page.locator(".note-list a").first().click();
  await page.getByRole("button", { name: "Заметка", exact: true }).click();
  await expect(page.locator(".prose table")).toBeVisible();
  await expect(page.locator(".prose pre")).toBeVisible();
  await expect(page.locator(".prose script, .prose img, .prose iframe")).toHaveCount(0);
  await expect(page.locator('.prose a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => "evil" in window)).toBeFalsy();
});

test("background polling stops, reconnect rechecks, and a reader waits for an explicit revision update", async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByLabel("Сохранить из X").fill(postUrl());
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "В очереди", exact: true })).toBeVisible();
  expect((await context.request.post("/__test/run")).ok()).toBeTruthy();
  await page.getByRole("link", { name: "Читать заметку" }).click();
  await expect(page.locator(".prose")).toBeVisible();
  const noteUrl = page.url();
  await page.clock.install();
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/notes/")) requests++;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".prose")).not.toBeVisible();
  const before = requests;
  await page.clock.fastForward(60000);
  expect(requests).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".prose")).toBeVisible();
  await context.setOffline(true);
  await page.clock.fastForward(15000);
  await expect(page.locator(".freshness")).toContainText("Обновление приостановлено");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".prose")).toBeVisible();
  await expect(page.locator(".freshness")).toContainText("Проверено");
  // Refresh through a second real owner tab, while the first retains its reading position.
  const editor = await context.newPage();
  await editor.goto(noteUrl);
  await editor.getByRole("button", { name: "Обновить источник…" }).click();
  await editor.getByRole("button", { name: "Получить новый захват" }).click();
  await expect(editor.getByRole("heading", { name: "В очереди", exact: true })).toBeVisible();
  expect((await context.request.post("/__test/run")).ok()).toBeTruthy();
  const original = await page.locator(".prose").textContent();
  await page.evaluate(() => window.scrollTo(0, 150));
  const position = await page.evaluate(() => window.scrollY);
  await page.clock.fastForward(15000);
  await expect(page.getByText("Текущий текст оставлен на месте", { exact: false })).toBeVisible();
  expect(await page.locator(".prose").textContent()).toBe(original);
  // Browser scroll anchoring may offset inserted notices, but never resets to top.
  if (position > 0) expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Загрузить новую версию" }).click();
  await expect(page.getByRole("button", { name: "Загрузить новую версию" })).toHaveCount(0);
  await editor.close();
});

test("pagination restarts visibly when the applied revision changes", async ({ page }) => {
  await login(page);
  await expect(page.locator(".note-list a").first()).toBeVisible();
  await page.route("**/api/v1/search", async (route) => {
    const payload = route.request().postDataJSON() as { cursor?: string };
    if (payload.cursor) {
      await route.fulfill({
        status: 409,
        json: {
          code: "revision_changed",
          message: "The projection changed.",
          requestId: crypto.randomUUID(),
        },
      });
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { nextCursor: string | null };
    body.nextCursor = "synthetic-next-page";
    await route.fulfill({ response, json: body });
  });
  await page.getByLabel("Поиск в заметках и оригиналах").fill("Flibbertigibbet");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await page.getByRole("button", { name: "Ещё заметки" }).click();
  await expect(
    page.getByText("Библиотека изменилась. Поиск начат заново.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".note-list a").first()).toBeVisible();
});
