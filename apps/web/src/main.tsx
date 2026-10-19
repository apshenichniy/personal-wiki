import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { client, clearOperations, message, request, setCsrf } from "./api.ts";
import { useLocation } from "./navigation.ts";
import { LibraryView } from "./library.tsx";
import { JobPage } from "./job.tsx";
import { Reader } from "./reader.tsx";
import { Link, Notice } from "./shared.tsx";
import "./style.css";
function App() {
  const path = useLocation();
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const channel = useRef<BroadcastChannel | null>(null);
  const check = useRef<() => void>(() => {});
  useEffect(() => {
    let generation = 0;
    let controller: AbortController | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      generation++;
      controller?.abort();
      clearTimeout(expiry);
      setCsrf("");
      clearOperations();
      setSignedIn(false);
      setReady(false);
      setChecking(false);
    };
    const verify = async () => {
      if (document.hidden) return;
      const current = ++generation;
      controller?.abort();
      controller = new AbortController();
      setChecking(true);
      setReady(false);
      try {
        const session = await request(client.session.get(), controller.signal);
        if (current !== generation) return;
        setCsrf(session.csrfToken);
        setSignedIn(true);
        setReady(true);
        setError("");
        clearTimeout(expiry);
        const expiresAt = Date.parse(session.expiresAt);
        // Browser timers overflow above ~24.8 days; a 30-day session needs a
        // bounded wake-up and another server check rather than immediate expiry.
        expiry = setTimeout(
          () => {
            if (Date.now() >= expiresAt) clear();
            else void verify();
          },
          Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now())),
        );
      } catch (e) {
        if (current !== generation) return;
        // A transport failure cannot prove revocation. Hide private views, but
        // keep pending mutation IDs until confirmed logout/401 or session expiry.
        setReady(false);
        setCsrf("");
        setError(message(e));
      } finally {
        if (current === generation) setChecking(false);
      }
    };
    check.current = () => {
      void verify();
    };
    const hide = () => {
      generation++;
      controller?.abort();
      flushSync(() => {
        setReady(false);
        setChecking(true);
      });
    };
    const visibility = () => {
      if (document.hidden) hide();
      else void verify();
    };
    const revoked = () => {
      clear();
    };
    channel.current = new BroadcastChannel("personal-wiki-session");
    channel.current.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "logout") clear();
    };
    window.addEventListener("wiki:unauthenticated", revoked);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", check.current);
    window.addEventListener("online", check.current);
    window.addEventListener("focus", check.current);
    void verify();
    return () => {
      generation++;
      controller?.abort();
      clearTimeout(expiry);
      channel.current?.close();
      window.removeEventListener("wiki:unauthenticated", revoked);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", check.current);
      window.removeEventListener("online", check.current);
      window.removeEventListener("focus", check.current);
    };
  }, []);
  const logout = async () => {
    try {
      await request(client.session.logout());
      window.dispatchEvent(new Event("wiki:unauthenticated"));
      channel.current?.postMessage("logout");
    } catch (e) {
      setError(`Выход не подтверждён: ${message(e)}`);
    }
  };
  const route = path.split("?")[0]!;
  const parts = route.split("/");
  return (
    <>
      <header className="app-header">
        <Link to="/">
          Personal Wiki<span className="brand-dot">.</span>
        </Link>
        <span className="private-label">Личная библиотека</span>
        {signedIn && (
          <button
            className="quiet"
            onClick={() => {
              void logout();
            }}
          >
            Выйти
          </button>
        )}
      </header>
      {!ready && (
        <main className="narrow auth">
          <h1>{checking ? "Проверяем доступ…" : "Ваша библиотека"}</h1>
          {!checking && (
            <>
              <p>
                {signedIn
                  ? "Не удалось подтвердить доступ. Содержимое скрыто до восстановления связи."
                  : "Войдите через Pocket ID, чтобы читать и сохранять материалы."}
              </p>
              {signedIn ? (
                <button className="primary" onClick={() => check.current()}>
                  Повторить проверку
                </button>
              ) : (
                <a
                  className="button primary"
                  href={`/auth/login?returnTo=${encodeURIComponent(route)}`}
                >
                  Войти
                </a>
              )}
            </>
          )}
          {error && <Notice error>{error}</Notice>}
        </main>
      )}
      {signedIn && (
        <div hidden={!ready}>
          {ready && error && <Notice error>{error}</Notice>}
          {route === "/" ? (
            <LibraryView enabled={ready} />
          ) : parts[1] === "jobs" ? (
            <JobPage key={route} id={parts[2]!} enabled={ready} />
          ) : parts[1] === "notes" ? (
            <Reader key={path} id={parts[2]!} enabled={ready} />
          ) : (
            <main className="narrow">
              <h1>Страница не найдена</h1>
              <Link to="/">Библиотека</Link>
            </main>
          )}
        </div>
      )}
      <footer>
        Personal Wiki <span>Только для вас</span>
      </footer>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Reader root missing");
createRoot(root).render(<App />);
