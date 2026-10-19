import { useEffect, useRef, useSyncExternalStore } from "react";
const event = "wiki:navigate";
let generation = 0;
window.addEventListener("popstate", () => generation++);
window.addEventListener(event, () => generation++);
// Finishing a mutation is independent of whether its originating view still
// owns navigation. Leaving and returning to the same URL also invalidates it.
export function useNavigationGuard() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const current = generation;
    return () => mounted.current && current === generation;
  };
}
export function navigate(path: string) {
  if (!/^\/(?:$|notes\/[a-f0-9-]{36}(?:\?.*)?$|jobs\/[a-f0-9-]{36}$)/.test(path)) return;
  history.pushState(null, "", path);
  window.dispatchEvent(new Event(event));
  window.scrollTo(0, 0);
}
const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  window.addEventListener(event, notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener(event, notify);
  };
};
export const useLocation = () =>
  useSyncExternalStore(subscribe, () => location.pathname + location.search);
