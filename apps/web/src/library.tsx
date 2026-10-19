import { useRef, useState } from "react";
import type { SearchResult } from "@personal-wiki/contracts/knowledge";
import { client, message, request, RequestError } from "./api.ts";
import { usePoll } from "./use-poll.ts";
import { SaveForm } from "./submission.tsx";
import { Freshness, Link, Notice, stages } from "./shared.tsx";
type Search = typeof SearchResult.Type;
export function LibraryView({ enabled }: { enabled: boolean }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [more, setMore] = useState<{
    key: string;
    revision: string;
    results: Search["results"];
    cursor: string | null;
  }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const found = usePoll(`search:${query}`, enabled, 15000, (signal) =>
    request(client.knowledge.search({ payload: { query } }), signal),
  );
  const jobs = usePoll("recent-jobs", enabled, 5000, (signal) =>
    request(client.jobs.recent(), signal),
  );
  const first = found.data;
  const extra = more?.key === query && more.revision === first?.appliedRevision ? more : undefined;
  const results = [...(first?.results ?? []), ...(extra?.results ?? [])];
  const cursor = extra ? extra.cursor : first?.nextCursor;
  const loadMore = async () => {
    if (!first || !cursor || loadingMore) return;
    const current = generation.current;
    const revision = first.appliedRevision;
    setLoadingMore(true);
    try {
      const page = await request(client.knowledge.search({ payload: { query, cursor, revision } }));
      if (current !== generation.current) return;
      setMore({
        key: query,
        revision,
        results: [...(extra?.results ?? []), ...page.results],
        cursor: page.nextCursor ?? null,
      });
    } catch (error) {
      if (current !== generation.current) return;
      if (error instanceof RequestError && error.code === "revision_changed") {
        setMore(undefined);
        found.refresh();
        setNotice("Библиотека изменилась. Поиск начат заново.");
      } else setNotice(message(error));
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  };
  return (
    <div className="library-layout">
      <main>
        <header className="page-heading">
          <p className="eyebrow">Личная коллекция</p>
          <h1>Библиотека</h1>
        </header>
        <SaveForm />
        <section className="collection">
          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault();
              generation.current++;
              setMore(undefined);
              setLoadingMore(false);
              setNotice("");
              setQuery(input.trim());
            }}
          >
            <label htmlFor="search">Поиск в заметках и оригиналах</label>
            <div className="input-row">
              <input
                id="search"
                type="search"
                maxLength={512}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Тема, слово или технический термин"
              />
              <button>Найти</button>
            </div>
          </form>
          <div className="section-heading">
            <h2>{query ? `Результаты: ${query}` : "Недавно сохранено"}</h2>
            <Freshness at={found.at} error={found.error} />
          </div>
          {notice && <Notice>{notice}</Notice>}
          {more && !extra && first && (
            <Notice>Библиотека обновилась. Показана первая страница новой версии.</Notice>
          )}
          {!first && !found.error && <p role="status">Загружаем заметки…</p>}
          {first && results.length === 0 && (
            <p className="empty">
              {query
                ? "Ничего не найдено. Попробуйте другое слово — поиск пока без морфологии и перевода."
                : "Здесь появятся сохранённые материалы. Добавьте первую ссылку выше."}
            </p>
          )}
          <ul className="note-list">
            {results.map((hit) => (
              <li key={hit.note.noteId}>
                <p className="eyebrow">
                  {hit.note.kind === "article" ? "Статья" : "Пост и обсуждение"} ·{" "}
                  {hit.matchedKind === "original"
                    ? `Совпадение в оригинале · ${hit.language}`
                    : "Заметка · RU"}
                </p>
                <h3>
                  <Link
                    to={`/notes/${hit.note.noteId}${hit.representationId ? `?source=${hit.representationId}` : ""}`}
                  >
                    {hit.note.title}
                  </Link>
                </h3>
                {query && <p className="excerpt">{hit.excerpt}</p>}
                <p className="muted folder">{hit.note.path.split("/").slice(0, -1).join(" / ")}</p>
              </li>
            ))}
          </ul>
          {cursor && (
            <button
              disabled={loadingMore}
              onClick={() => {
                void loadMore();
              }}
            >
              {loadingMore ? "Загружаем…" : "Ещё заметки"}
            </button>
          )}
        </section>
      </main>
      <aside className="activity">
        <div className="section-heading">
          <h2>Обработка</h2>
          <Freshness at={jobs.at} error={jobs.error} />
        </div>
        {jobs.data?.jobs.length === 0 && <p className="muted">Заданий пока нет.</p>}
        <ul>
          {jobs.data?.jobs.map((job) => (
            <li key={job.jobId}>
              <Link to={`/jobs/${job.jobId}`}>
                <span className={`stage stage-${job.stage}`}>
                  {stages[job.stage]}
                  {job.stage === "succeeded" && job.warnings.length ? " · с примечаниями" : ""}
                </span>
                <span className="job-anchor">Пост {job.anchorId}</span>
              </Link>
            </li>
          ))}
        </ul>
        {jobs.data?.hasMore && <p className="muted">Показаны 50 заданий; активные идут первыми.</p>}
      </aside>
    </div>
  );
}
