import { createConnection, type Socket } from "node:net";
import { Effect, Layer } from "effect";

function connect() {
  const path = process.env.WIKI_PUBLISHER_SOCKET;
  const token = process.env.WIKI_PUBLISHER_TOKEN;
  if (!path || !token) throw new Error("Start through the persistent-lock supervisor.");
  return { socket: createConnection(path), token };
}
export const publisherRequest = (input: Record<string, unknown>) =>
  new Promise<{ ok: boolean; output?: string }>((resolve, reject) => {
    const { socket, token } = connect();
    let response = "";
    socket.setTimeout(35000, () => socket.destroy(new Error("Publisher timeout")));
    socket.on("connect", () => socket.write(JSON.stringify({ ...input, token }) + "\n"));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.length > 24 * 1024 * 1024)
        socket.destroy(new Error("Publisher response too large"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch {
        reject(new Error("Publisher response missing"));
      }
      socket.destroy();
    });
  });
export const ownershipLayer = () =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<Socket>((resolve, reject) => {
            const { socket, token } = connect();
            let response = "";
            socket.on("error", reject);
            socket.on("connect", () =>
              socket.write(JSON.stringify({ method: "hold", token }) + "\n"),
            );
            socket.on("data", (chunk) => {
              response += chunk.toString();
              if (response === '{"ok":true}\n') resolve(socket);
            });
            // Supervisor loss removes write authority immediately. No new Git command can
            // run; SQLite epoch checks fence callbacks after a successor takes ownership.
            socket.on("close", () => {
              reject(new Error("Publisher ownership lost"));
              process.kill(process.pid, "SIGTERM");
            });
          }),
      ),
      (socket) =>
        Effect.sync(() => {
          socket.removeAllListeners("close");
          socket.destroy();
        }),
    ),
  );
