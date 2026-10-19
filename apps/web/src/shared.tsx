import type { ReactNode } from "react";
import type { JobStage } from "@personal-wiki/contracts/jobs";
import { navigate } from "./navigation.ts";
export const stages: Record<JobStage, string> = {
  queued: "В очереди",
  acquiring: "Сохраняем источник",
  prepared: "Источник сохранён",
  curating: "Готовим заметку",
  validating: "Проверяем заметку",
  publishing: "Публикуем",
  blocked: "Требуется действие",
  stopping: "Останавливаем",
  succeeded: "Готово",
  failed: "Не удалось завершить",
  expired: "Время истекло",
  cancelled: "Отменено",
};
export const date = (value: string) =>
  new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
export function Link({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a
      href={to}
      onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
          event.preventDefault();
          navigate(to);
        }
      }}
    >
      {children}
    </a>
  );
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={error ? "notice error" : "notice"} role={error ? "alert" : "status"}>
      {children}
    </div>
  );
}
export function Warnings({ warnings }: { warnings: readonly string[] }) {
  return warnings.length ? (
    <details className="warnings">
      <summary>Ограничения и примечания · {warnings.length}</summary>
      <ul>
        {warnings.map((value, index) => (
          <li key={index}>{value}</li>
        ))}
      </ul>
    </details>
  ) : null;
}
export function Freshness({ error, at }: { error?: string | undefined; at?: number | undefined }) {
  return (
    <p className="muted freshness" role="status">
      {error
        ? `Обновление приостановлено. ${error}`
        : at
          ? `Проверено ${new Date(at).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}`
          : "Подключаемся к библиотеке…"}
    </p>
  );
}
