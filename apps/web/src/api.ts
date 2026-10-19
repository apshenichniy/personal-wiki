import { Effect } from "effect";
import { makeReaderClient } from "@personal-wiki/client/reader";
let csrfToken = "";
export const setCsrf = (value: string) => {
  csrfToken = value;
};
export const client = await Effect.runPromise(makeReaderClient(location.origin, () => csrfToken));
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function request<A, E>(
  operation: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation), signal ? { signal } : undefined);
  if (result._tag === "Success") return result.success;
  const error = result.failure;
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "connection";
  if (code === "unauthenticated") window.dispatchEvent(new Event("wiki:unauthenticated"));
  throw new RequestError(
    code,
    code === "connection"
      ? "Нет связи с библиотекой. Повторите запрос."
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "Не удалось выполнить запрос.",
  );
}
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "Не удалось выполнить запрос.";
const operations = new Map<string, string>();
export async function mutation<A>(
  key: string,
  send: (requestId: string) => Promise<A>,
): Promise<A> {
  const id = operations.get(key) ?? crypto.randomUUID();
  operations.set(key, id);
  const result = await send(id);
  operations.delete(key);
  return result;
}
export const clearOperations = () => operations.clear();
