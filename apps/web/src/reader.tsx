import { useEffect, useRef, useState } from "react";
import type { CaptureDetail, NoteDetail, Citation } from "@personal-wiki/contracts/knowledge";
import { client, request, RequestError } from "./api.ts";
import { usePoll } from "./use-poll.ts";
import { External, SafeMarkdown } from "./markdown.tsx";
import { date, Freshness, Link, Notice, Warnings } from "./shared.tsx";
import { RefreshSource } from "./submission.tsx";
type Bundle = {
  detail: typeof NoteDetail.Type;
  captures: (typeof CaptureDetail.Type)[];
  related: (typeof NoteDetail.Type)[];
};
async function loadBundle(id: string, signal: AbortSignal, previous?: Bundle): Promise<Bundle> {
  for (let attempt = 0; ; attempt++) {
    try {
      const detail = await request(
        client.knowledge.note({ params: { noteId: id }, query: {} }),
        signal,
      );
      if (previous?.detail.appliedRevision === detail.appliedRevision) return previous;
      const query = { revision: detail.appliedRevision };
      const captures = await Promise.all(
        detail.note.captureIds.map((captureId) =>
          request(client.knowledge.capture({ params: { captureId }, query }), signal),
        ),
      );
      const related = await Promise.all(
        detail.note.relatedNoteIds.map((noteId) =>
          request(client.knowledge.note({ params: { noteId }, query }), signal),
        ),
      );
      return { detail, captures, related };
    } catch (error) {
      if (attempt >= 1 || !(error instanceof RequestError) || error.code !== "revision_changed")
        throw error;
    }
  }
}
function Sources({ bundle, selected }: { bundle: Bundle; selected: string | null }) {
  return (
    <section className="sources">
      <p className="muted">
        Сохранённый оригинал. Это захват на указанную дату, а не новая загрузка из X.
      </p>
      {bundle.captures.map(({ capture, source }) => (
        <article key={capture.captureId} id={`capture-${capture.captureId}`}>
          <header>
            <p className="eyebrow">
              {source.kind === "x_article" ? "X Article" : "Пост и обсуждение"}
            </p>
            <h2>Захват от {date(capture.endedAt)}</h2>
            <External href={source.canonicalUrl}>Открыть источник в X ↗</External>
            <p className="muted">
              Основной материал: {capture.coverage.main} · Обсуждение: {capture.coverage.discussion}{" "}
              · Контекст: {capture.coverage.context}
            </p>
            <small>Capture {capture.captureId}</small>
            <Warnings warnings={capture.warnings} />
          </header>
          {capture.representations.map((representation) => (
            <section
              key={representation.representationId}
              id={`representation-${representation.representationId}`}
              className={
                selected === representation.representationId
                  ? "source-text selected-source"
                  : "source-text"
              }
            >
              <h3>
                {representation.kind === "translation" ? "Связанный перевод" : "Текст источника"} ·{" "}
                {representation.language}
              </h3>
              <p className="original">{representation.text}</p>
              <a href={`/api/v1/assets/${representation.assetId}`} download>
                Скачать сохранённый файл
              </a>
            </section>
          ))}
          <details open={capture.observations.length < 4}>
            <summary>Посты в захвате · {capture.observations.length}</summary>
            {capture.observations.map((post) => (
              <section
                className="source-post"
                tabIndex={-1}
                key={post.providerId}
                id={`post-${capture.captureId}-${post.providerId}`}
              >
                <p>
                  <strong>{post.authorName || post.authorHandle || "Автор не указан"}</strong> ·{" "}
                  <External href={post.canonicalUrl}>Пост {post.providerId} ↗</External>
                </p>
                {post.postedAt && <p className="muted">{date(post.postedAt)}</p>}
                <p className="original">{post.text}</p>
                {post.parentId && <small>Ответ на {post.parentId}</small>}
              </section>
            ))}
          </details>
        </article>
      ))}
    </section>
  );
}
export function Reader({ id, enabled }: { id: string; enabled: boolean }) {
  const selected = new URLSearchParams(location.search).get("source");
  const [tab, setTab] = useState<"note" | "source">(selected ? "source" : "note");
  const latest = useRef<Bundle | undefined>(undefined);
  const [shown, setShown] = useState<Bundle>();
  const state = usePoll(`note:${id}`, enabled, 15000, async (signal) => {
    const value = await loadBundle(id, signal, latest.current);
    latest.current = value;
    return value;
  });
  useEffect(() => {
    if (state.data && !shown) setShown(state.data);
  }, [state.data, shown]);
  const openCitation = (citation: typeof Citation.Type) => {
    setTab("source");
    requestAnimationFrame(() => {
      const target = document.getElementById(`post-${citation.captureId}-${citation.providerId}`);
      const details = target?.closest("details");
      if (details) details.open = true;
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
  };
  const bundle = shown;
  const note = bundle?.detail.note;
  const refreshCapture = bundle?.captures
    .filter((entry) => entry.source.sourceId === note?.sourceId)
    .sort((a, b) => b.capture.endedAt.localeCompare(a.capture.endedAt))[0];
  const changed =
    bundle && state.data && state.data.detail.appliedRevision !== bundle.detail.appliedRevision;
  return (
    <main className="reader narrow">
      <Link to="/">← Библиотека</Link>
      <Freshness at={state.at} error={state.error} />
      {changed && (
        <Notice>
          Библиотека обновилась. Текущий текст оставлен на месте.{" "}
          <button
            onClick={() => {
              setShown(state.data);
            }}
          >
            Загрузить новую версию
          </button>
        </Notice>
      )}
      {!bundle || !note ? (
        <p role="status">
          {state.error
            ? "Заметка недоступна или больше не входит в активную библиотеку."
            : "Открываем заметку и её источники…"}
        </p>
      ) : (
        <>
          <header className="reader-heading">
            <p className="eyebrow">
              {note.kind === "article" ? "Статья" : "Пост и обсуждение"} · Заметка на русском
            </p>
            <h1>{note.title}</h1>
            <p className="muted">
              {note.path.split("/").slice(0, -1).join(" / ")} · {bundle.captures.length}{" "}
              {bundle.captures.length === 1 ? "захват" : "захвата"}
            </p>
          </header>
          <nav className="tabs" aria-label="Вид материала">
            <button aria-pressed={tab === "note"} onClick={() => setTab("note")}>
              Заметка
            </button>
            <button aria-pressed={tab === "source"} onClick={() => setTab("source")}>
              Сохранённый оригинал
            </button>
          </nav>
          {tab === "note" ? (
            <>
              <SafeMarkdown
                text={note.markdown}
                citations={note.citations}
                onSource={openCitation}
              />
              <section className="provenance">
                <h2>Источники и ссылки</h2>
                {bundle.captures.map(({ capture }) => (
                  <div key={capture.captureId}>
                    <p>Захват: {date(capture.endedAt)}</p>
                    <Warnings warnings={capture.warnings} />
                  </div>
                ))}
                <ul className="citation-list">
                  {note.citations.map((citation) => (
                    <li key={citation.citationId}>
                      <External href={citation.canonicalUrl}>Пост {citation.providerId} ↗</External>
                      <button className="quiet" onClick={() => openCitation(citation)}>
                        В сохранённом захвате
                      </button>
                      <small>
                        {bundle.captures
                          .find((c) => c.capture.captureId === citation.captureId)
                          ?.capture.endedAt.slice(0, 10)}
                      </small>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : (
            <Sources bundle={bundle} selected={selected} />
          )}
          {bundle.related.length > 0 && (
            <section className="related">
              <h2>Связанные заметки</h2>
              <ul>
                {bundle.related.map(({ note }) => (
                  <li key={note.noteId}>
                    <Link to={`/notes/${note.noteId}`}>{note.title} →</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {refreshCapture && <RefreshSource url={refreshCapture.capture.submittedUrl} />}
        </>
      )}
    </main>
  );
}
