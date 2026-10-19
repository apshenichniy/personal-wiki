import { useRef, useState } from "react";
import type { JobView } from "@personal-wiki/contracts/jobs";
import { client, message, mutation, request } from "./api.ts";
import { usePoll } from "./use-poll.ts";
import { navigate, useNavigationGuard } from "./navigation.ts";
import { RefreshSource } from "./submission.tsx";
import { External } from "./markdown.tsx";
import { date, Freshness, Link, Notice, stages, Warnings } from "./shared.tsx";
const reasonText: Record<string, string> = {
  provider_start_unknown:
    "Провайдер мог принять запрос. Сначала нужно сверить запуск; повторный захват заблокирован.",
  auth: "Нужно восстановить вход агента на сервере.",
  quota: "Достигнут лимит подписки агента. Задание сохранено.",
  process_ownership_unknown: "Ожидаем подтверждения остановки прежнего процесса.",
  source_unavailable: "Основной материал недоступен. Заметка не создана.",
  deadline: "Истёк срок выполнения задания.",
  source_capacity: "Источник превышает допустимый объём обработки.",
};
function Actions({ job, refresh }: { job: JobView; refresh: () => void }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const guard = useNavigationGuard();
  const act = async (action: "cancel" | "resume" | "retry_retained") => {
    if (busy.current) return;
    const isCurrent = guard();
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const result = await mutation(`${action}:${job.jobId}`, (requestId) => {
        const input = { payload: { requestId, jobId: job.jobId } };
        return request(
          action === "cancel"
            ? client.jobs.cancel(input)
            : action === "resume"
              ? client.jobs.resume(input)
              : client.jobs.retryRetained(input),
        );
      });
      if (!isCurrent()) return;
      if (result.jobId !== job.jobId) navigate(`/jobs/${result.jobId}`);
      else refresh();
    } catch (e) {
      if (!isCurrent()) return;
      setError(message(e));
      refresh();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <div className="job-actions">
      {job.allowedActions.map((action) =>
        action === "refresh" ? (
          <RefreshSource key={action} url={job.normalizedUrl} />
        ) : (
          <button
            key={action}
            disabled={pending}
            onClick={() => {
              void act(action);
            }}
          >
            {action === "cancel"
              ? "Остановить задание"
              : action === "resume"
                ? "Продолжить"
                : "Повторить из сохранённого источника"}
          </button>
        ),
      )}
      {error && <Notice error>{error}</Notice>}
    </div>
  );
}
export function JobPage({ id, enabled }: { id: string; enabled: boolean }) {
  const state = usePoll(`job:${id}`, enabled, 5000, (signal) =>
    request(client.jobs.get({ params: { jobId: id } }), signal),
  );
  const job = state.data;
  return (
    <main className="narrow">
      <Link to="/">← Библиотека</Link>
      <Freshness at={state.at} error={state.error} />
      {!job ? (
        <p role="status">{state.error ? "Не удалось открыть задание." : "Открываем задание…"}</p>
      ) : (
        <>
          <p className="eyebrow">Обработка источника</p>
          <h1>{stages[job.stage]}</h1>
          <p>
            <External href={job.submittedUrl}>Пост {job.anchorId} ↗</External>
          </p>
          <dl className="facts">
            <div>
              <dt>Добавлен</dt>
              <dd>{date(job.createdAt)}</dd>
            </div>
            <div>
              <dt>В работе</dt>
              <dd>
                {["cancelled", "failed", "expired"].includes(job.stage)
                  ? "Завершено"
                  : job.startedAt
                    ? `${Math.max(0, Math.floor(((job.receipt ? Date.parse(job.receipt.publishedAt) : Date.now()) - Date.parse(job.startedAt)) / 60000))} мин`
                    : "Ожидает своей очереди"}
              </dd>
            </div>
            <div>
              <dt>Попытки агента</dt>
              <dd>
                {job.counters.launches} / {job.policy.maxLaunches}
              </dd>
            </div>
          </dl>
          {job.reason && <Notice>{reasonText[job.reason] ?? job.reason}</Notice>}
          {job.cleanupPending && (
            <Notice>Подтверждаем завершение процесса. Задание ещё не остановлено.</Notice>
          )}
          {job.stage === "publishing" && (
            <Notice>
              Завершаем публикацию. Отмена больше не может удалить уже принятую запись.
            </Notice>
          )}
          {job.captureSummary?.map((capture) => (
            <section className="capture-summary" key={capture.captureId}>
              <h2>Сохранённый захват</h2>
              <p>
                {date(capture.endedAt)} · {capture.posts} постов
              </p>
              <p className="muted">
                Основной материал: {capture.coverage.main} · Обсуждение:{" "}
                {capture.coverage.discussion} · Контекст: {capture.coverage.context}
              </p>
              <Warnings warnings={capture.warnings} />
            </section>
          ))}
          <Warnings warnings={job.warnings} />
          {job.receipt && (
            <section>
              <h2>Готовые заметки</h2>
              <ul className="result-links">
                {job.receipt.noteIds.map((id, index) => (
                  <li key={id}>
                    <Link to={`/notes/${id}`}>
                      {index ? "Открыть связанную статью" : "Читать заметку"} →
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Actions job={job} refresh={state.refresh} />
          {job.previousJobId && (
            <p>
              <Link to={`/jobs/${job.previousJobId}`}>Предыдущее задание</Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}
