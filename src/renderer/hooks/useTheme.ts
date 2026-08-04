import { useCallback, useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "niri";

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Theme {
  if (typeof document === "undefined") return "light";
  const el = document.documentElement;
  if (el.classList.contains("niri")) return "niri";
  return el.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

type ToggleOrigin = { x: number; y: number };

const STORED_THEMES = new Set(["light", "dark", "niri"]);

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Follow OS theme when the user has not forced a preference (or chose system)
  useEffect(() => {
    const storedTheme = (): string | null => {
      try {
        return localStorage.getItem("pi-theme");
      } catch {
        return null;
      }
    };
    if (STORED_THEMES.has(storedTheme() ?? "")) return;

    const applySystem = () => {
      // Re-check on every invocation: toggling the theme flips Electron's
      // nativeTheme, which fires this media-query listener again. Without
      // this guard the listener resets themeSource to "system" and reverts
      // the toggle (feedback loop).
      const stored = storedTheme();
      if (STORED_THEMES.has(stored ?? "")) return;
      const dark = systemPrefersDark();
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.remove("niri");
      listeners.forEach((cb) => cb());
      void window.piBridge?.setThemeSource?.("system");
    };
    applySystem();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => applySystem();
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  const applyTheme = useCallback((next: Theme, origin?: ToggleOrigin) => {
    const apply = () => {
      const el = document.documentElement;
      el.classList.toggle("dark", next !== "light");
      el.classList.toggle("niri", next === "niri");
      try {
        localStorage.setItem("pi-theme", next);
      } catch {
        // ignore storage errors (private mode, quota, etc.)
      }
      // nativeTheme has no "niri"; drive system UI as dark.
      void window.piBridge?.setThemeSource?.(next === "light" ? "light" : "dark");
      listeners.forEach((cb) => cb());
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";

    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
          },
          {
            duration: 450,
            easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // transition cancelled — ignore
      });
  }, []);

  const setTheme = useCallback(
    (next: Theme) => {
      if (next !== getSnapshot()) applyTheme(next);
    },
    [applyTheme],
  );

  const toggleTheme = useCallback(
    (origin?: ToggleOrigin) => {
      const next: Theme = getSnapshot() === "light" ? "dark" : "light";
      applyTheme(next, origin);
    },
    [applyTheme],
  );

  return { theme, setTheme, toggleTheme, isDark: theme !== "light" };
}
