import { useEffect, useRef, useState } from "react";
import { message } from "./api.ts";
/** Each key/visibility generation owns one request. Aborted or superseded
 * responses never commit, including transports that finish after abort. */
export function usePoll<A>(
  key: string,
  enabled: boolean,
  interval: number,
  load: (signal: AbortSignal) => Promise<A>,
) {
  const loader = useRef(load);
  loader.current = load;
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; data?: A; error?: string; at?: number }>({
    key,
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let failures = 0;
    const run = async () => {
      try {
        const data = await loader.current(controller.signal);
        if (!live) return;
        failures = 0;
        setState({ key, data, at: Date.now() });
      } catch (error) {
        if (!live) return;
        failures++;
        setState((old) => ({ ...(old.key === key ? old : { key }), error: message(error) }));
      }
      if (live)
        timer = setTimeout(
          () => {
            void run();
          },
          Math.min(60_000, interval * 2 ** failures),
        );
    };
    void run();
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, enabled, interval, refresh]);
  return {
    ...(state.key === key ? state : { key }),
    refresh: () => setRefresh((value) => value + 1),
  };
}
