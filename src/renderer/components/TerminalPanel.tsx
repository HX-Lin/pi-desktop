import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  /** Directory the shell starts in. */
  cwd: string;
  /** Whether this terminal is currently the visible panel. */
  active: boolean;
}

function cssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function isDarkBackground(color: string): boolean {
  const m = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return true; // unknown → assume dark (app default is dark)
  const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
  return lum < 128;
}

function readTheme() {
  const dark = isDarkBackground(cssVar("--bg", "#000000"));
  return {
    // The terminal surface is transparent — the application layer (right panel
    // / wallpaper) shows through, matching the translucent kitty-style look.
    background: "rgba(0, 0, 0, 0)",
    foreground: cssVar("--text", dark ? "#e5e5e5" : "#111111"),
    cursor: cssVar("--accent", dark ? "#f97316" : "#ea580c"),
    selectionBackground: cssVar("--selection", dark ? "rgba(234, 88, 12, 0.38)" : "rgba(234, 88, 12, 0.22)"),
    black: dark ? "#181818" : "#111111",
    red: dark ? "#ef4444" : "#b91c1c",
    green: dark ? "#4ade80" : "#15803d",
    yellow: dark ? "#facc15" : "#a16207",
    blue: dark ? "#60a5fa" : "#1d4ed8",
    magenta: dark ? "#f472b6" : "#be185d",
    cyan: dark ? "#22d3ee" : "#0e7490",
    white: dark ? "#e5e5e5" : "#111111",
    brightBlack: dark ? "#6b7280" : "#4b5563",
    brightRed: dark ? "#f87171" : "#dc2626",
    brightGreen: dark ? "#86efac" : "#16a34a",
    brightYellow: dark ? "#fde047" : "#ca8a04",
    brightBlue: dark ? "#93c5fd" : "#2563eb",
    brightMagenta: dark ? "#f9a8d4" : "#c026d3",
    brightCyan: dark ? "#67e8f9" : "#0891b2",
    brightWhite: dark ? "#ffffff" : "#111111",
  };
}

/**
 * Embedded xterm terminal backed by a main-process node-pty session.
 *
 * Lifecycle: the xterm surface is created immediately; the pty is spawned only
 * once the panel has a real (non-zero) size, so the shell never starts in a
 * broken 0-sized grid. The session survives tab switches (display toggled)
 * and is torn down only when `cwd` changes or the component unmounts.
 */
export function TerminalPanel({ cwd, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termIdRef = useRef<number | null>(null);
  const createdRef = useRef(false);
  const disposeRef = useRef<(() => void) | null>(null);
  const calibrateTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState("");
  const bridgeAvailable = Boolean(window.piBridge?.terminal);

  const showStatus = useCallback((message: string) => {
    setStatus(message);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatus(""), 6000);
  }, []);

  const ensureCreated = useCallback(() => {
    const container = containerRef.current;
    if (createdRef.current || !container || !window.piBridge?.terminal) return;
    createdRef.current = true;

    const theme = readTheme();
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: cssVar("--font-mono", "monospace"),
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      allowTransparency: true,
      theme,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let createRequested = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let createTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    // Initial shell output can race the async create() resolve (IPC channels
    // are not strictly ordered) — buffer unknown-id data and flush it once the
    // session id is known so the first prompt is never lost.
    const pendingData = new Map<number, string[]>();

    const createPty = (cols: number, rows: number) => {
      if (createRequested || disposed) return;
      createRequested = true;
      showStatus("Starting shell…");
      // If the main process never answers (e.g. node-pty cold-load stalls in
      // the packaged asar), surface it instead of waiting forever.
      createTimeoutTimer = setTimeout(() => {
        if (disposed || termIdRef.current != null) return;
        console.log("[terminal] create timeout — main process not answering");
        showStatus("Shell start timed out (main process stuck?) — click + to retry");
      }, 10000);
      window.piBridge.terminal
        .create(cwd, cols, rows)
        .then(({ id }) => {
          if (createTimeoutTimer) clearTimeout(createTimeoutTimer);
          if (disposed) {
            void window.piBridge.terminal.kill(id);
            return;
          }
          termIdRef.current = id;
          setStatus("");
          term.onData((data) => void window.piBridge.terminal.write(id, data));
          // Reliable copy/paste via the main-process clipboard (xterm's default
          // Ctrl+Shift+C/V can be swallowed before reaching navigator.clipboard).
          term.attachCustomKeyEventHandler((event) => {
            if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return true;
            const key = event.key.toLowerCase();
            if (key === "c") {
              const selection = term.getSelection();
              if (selection) void window.piBridge.writeClipboardText(selection);
              return false;
            }
            if (key === "v") {
              void window.piBridge.readClipboardText().then((text) => {
                if (text) term.paste(text);
              });
              return false;
            }
            return true;
          });

          // Flush any output that arrived before the id was known.
          const buffered = pendingData.get(id);
          if (buffered) {
            for (const chunk of buffered) {
              term.write(chunk, repaint);
            }
            pendingData.delete(id);
          }

          // Push the real size repeatedly: a resize right after spawn can lose
          // its SIGWINCH while the shell is still starting, and the shell only
          // repaints its prompt (making the first paint non-blank) once it
          // receives it. Also covers a still-settling container layout — the
          // panel animates width, so we keep re-checking until the fitted size
          // stops changing.
          let calibrateCount = 0;
          let calibrateTimer: ReturnType<typeof setTimeout> | null = null;
          const calibrate = () => {
            if (disposed || termIdRef.current !== id) return;
            const before = `${term.cols}x${term.rows}`;
            try {
              fit.fit();
            } catch {
              /* ignore */
            }
            const after = `${term.cols}x${term.rows}`;
            if (before !== after && calibrateCount < 20) {
              calibrateCount += 1;
              calibrateTimer = setTimeout(calibrate, 120);
              calibrateTimersRef.current.push(calibrateTimer);
            }
            void window.piBridge.terminal.resize(id, term.cols, term.rows);
            try {
              term.refresh(0, term.rows - 1);
            } catch {
              /* ignore */
            }
          };
          const timers = [0, 120, 400].map((delay) => setTimeout(calibrate, delay));
          calibrateTimersRef.current.push(...timers);
          calibrateTimersRef.current.push(setTimeout(calibrate, 1500));
          term.focus();
        })
        .catch((error: unknown) => {
          console.log("[terminal] create error", String(error));
          if (!disposed) showStatus(error instanceof Error ? error.message : String(error));
        });
    };

    // Spawn the pty only once the panel has a real size. Creating it inside a
    // 0-sized (still settling / animating) panel gives the shell a broken
    // grid whose output never becomes visible until a later refit.
    const tryCreate = () => {
      if (disposed || createRequested) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w < 10 || h < 10) {
        retryTimer = setTimeout(tryCreate, 100);
        return;
      }
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      createPty(term.cols, term.rows);
    };
    tryCreate();

    // Force a repaint once the write has been parsed. xterm schedules
    // repaints on rAF, which some Wayland/XWayland setups never fire
    // reliably — that is why the output only appeared after switching away
    // and back. We call the renderer's synchronous paint directly to bypass
    // the rAF debounce.
    const repaint = () => {
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        /* ignore */
      }
      try {
        // Internal API: RenderService._renderRows paints synchronously.
        const svc = (term as unknown as { _renderService?: { _renderRows?: (start: number, end: number) => void } })
          ._renderService;
        svc?._renderRows?.(0, term.rows - 1);
      } catch {
        /* ignore */
      }
    };

    const offEvent = window.piBridge.terminal.onEvent((event) => {
      if (event.type === "data") {
        if (termIdRef.current === event.id) {
          term.write(event.data, repaint);
          // Defensive: if the surface was still tiny when output arrived,
          // refit so the text becomes visible immediately.
          if (container.clientWidth < 10 || term.cols < 5) {
            try {
              fit.fit();
            } catch {
              /* ignore */
            }
            void window.piBridge.terminal.resize(event.id, term.cols, term.rows);
          }
        } else {
          // Output that raced create()'s resolve: buffer until the id is known.
          const list = pendingData.get(event.id) ?? [];
          list.push(event.data);
          if (list.length > 500) list.shift();
          pendingData.set(event.id, list);
        }
      } else if (event.type === "exit" && event.id === termIdRef.current) {
        termIdRef.current = null;
        showStatus(event.code === 0 ? "Terminal closed" : `Process exited with code ${event.code}`);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      // Always refit (the container can settle long after the pty was
      // created); only push the size once the session id exists.
      try {
        fit.fit();
      } catch {
        return;
      }
      if (termIdRef.current != null) {
        void window.piBridge.terminal.resize(termIdRef.current, term.cols, term.rows);
      } else {
        tryCreate(); // size just arrived — spawn the pty now
      }
    });
    resizeObserver.observe(container);

    disposeRef.current = () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (createTimeoutTimer) clearTimeout(createTimeoutTimer);
      resizeObserver.disconnect();
      offEvent();
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      for (const timer of calibrateTimersRef.current) clearTimeout(timer);
      calibrateTimersRef.current = [];
      pendingData.clear();
      if (termIdRef.current != null) {
        void window.piBridge.terminal.kill(termIdRef.current);
      }
      termIdRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      createdRef.current = false;
      disposeRef.current = null;
    };
  }, [cwd, showStatus]);

  // Refit + focus whenever the panel becomes visible. useLayoutEffect so the
  // container already has its final layout (a freshly created tab swaps
  // display:none → block in the same commit).
  useLayoutEffect(() => {
    if (!active) return;
    ensureCreated();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      // Second frame: layout is stable, re-fit and push the real size to the
      // pty — the SIGWINCH causes the shell to repaint its prompt, which is
      // what makes an otherwise blank first paint show content.
      raf2 = requestAnimationFrame(() => {
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term || !fit) return;
        try {
          fit.fit();
        } catch {
          /* container may be hidden */
        }
        if (termIdRef.current != null) {
          void window.piBridge.terminal.resize(termIdRef.current, term.cols, term.rows);
        }
        // Force a repaint in case the renderer missed the first frame.
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* ignore */
        }
        term.focus();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [active, ensureCreated]);

  // A changed directory means a new shell: tear the old one down so the next
  // visible pass creates a fresh session. Skip the mount run — the panel is
  // created by useLayoutEffect above and must not be disposed right after.
  const prevCwd = useRef(cwd);
  useEffect(() => {
    if (prevCwd.current === cwd) return;
    prevCwd.current = cwd;
    disposeRef.current?.();
  }, [cwd]);

  // Component unmount (tab closed / window closed) always kills the pty.
  useEffect(
    () => () => {
      disposeRef.current?.();
    },
    [],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {status ? (
        <div
          style={{
            flexShrink: 0,
            padding: "4px 10px",
            fontSize: 11,
            color: "var(--text-dim)",
            background: "var(--bg-hover)",
            borderBottom: "1px solid var(--border)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {status}
        </div>
      ) : null}
      {bridgeAvailable ? null : (
        <div
          style={{
            flexShrink: 0,
            padding: "4px 10px",
            fontSize: 11,
            color: "var(--text-dim)",
            background: "var(--bg-hover)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          Terminal bridge unavailable
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          padding: 4,
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      />
    </div>
  );
}
