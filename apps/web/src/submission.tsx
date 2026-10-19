import { useRef, useState } from "react";
import { normalizeSubmission } from "@personal-wiki/contracts/x-url";
import { client, message, mutation, request } from "./api.ts";
import { navigate } from "./navigation.ts";
import { Notice } from "./shared.tsx";
export async function submit(url: string, mode: "save" | "refresh") {
  normalizeSubmission(url);
  const result = await mutation(`submit:${mode}:${url}`, (requestId) =>
    request(client.jobs.submit({ payload: { requestId, mode, url } })),
  );
  if (result.noteId && result.outcome === "existing_note") navigate(`/notes/${result.noteId}`);
  else if (result.job) navigate(`/jobs/${result.job.jobId}`);
}
export function SaveForm() {
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  return (
    <form
      className="save-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current) return;
        busy.current = true;
        setPending(true);
        setError("");
        void submit(url.trim(), "save")
          .catch((error: unknown) => setError(message(error)))
          .finally(() => {
            busy.current = false;
            setPending(false);
          });
      }}
    >
      <label htmlFor="source-url">Сохранить из X</label>
      <div className="input-row">
        <input
          id="source-url"
          type="url"
          required
          maxLength={2048}
          placeholder="Ссылка на пост или тред"
          value={url}
          disabled={pending}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button className="primary" disabled={pending}>
          {pending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
      <p className="muted">
        Пост, содержательные ответы и связанные заметки. Уже сохранённый источник откроется без
        повторного захвата.
      </p>
      {error && (
        <Notice error>{error} Повторная отправка сохранит тот же идентификатор запроса.</Notice>
      )}
    </form>
  );
}
export function RefreshSource({ url }: { url: string }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  return (
    <div className="refresh-source">
      {confirm ? (
        <>
          <p>
            Получить свежий захват источника и обновить заметку? Предыдущие материалы останутся в
            истории.
          </p>
          <button
            disabled={pending}
            onClick={() => {
              if (busy.current) return;
              busy.current = true;
              setPending(true);
              void submit(url, "refresh")
                .catch((e: unknown) => setError(message(e)))
                .finally(() => {
                  busy.current = false;
                  setPending(false);
                });
            }}
          >
            {pending ? "Отправляем…" : "Получить новый захват"}
          </button>
          <button className="quiet" disabled={pending} onClick={() => setConfirm(false)}>
            Оставить текущий
          </button>
        </>
      ) : (
        <button className="quiet" onClick={() => setConfirm(true)}>
          Обновить источник…
        </button>
      )}
      {error && <Notice error>{error}</Notice>}
    </div>
  );
}
