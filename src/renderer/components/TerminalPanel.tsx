import { useCallback, useEffect, useRef, useState } from "react";
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
    background: cssVar("--bg", dark ? "#1e1e1e" : "#ffffff"),
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
 * Lifecycle: the pty is created the first time the panel becomes visible for
 * a given `cwd`, and is kept alive while the panel is hidden (tab switches).
 * It is torn down only when `cwd` changes or the component unmounts (closing
 * the tab / window).
 */
export function TerminalPanel({ cwd, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termIdRef = useRef<number | null>(null);
  const createdRef = useRef(false);
  const disposeRef = useRef<(() => void) | null>(null);
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
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    window.piBridge.terminal
      .create(cwd, term.cols, term.rows)
      .then(({ id }) => {
        if (disposed) {
          void window.piBridge.terminal.kill(id);
          return;
        }
        termIdRef.current = id;
        term.onData((data) => void window.piBridge.terminal.write(id, data));
        term.focus();
      })
      .catch((error: unknown) => {
        if (!disposed) showStatus(error instanceof Error ? error.message : String(error));
      });

    const offEvent = window.piBridge.terminal.onEvent((event) => {
      if (event.id !== termIdRef.current) return;
      if (event.type === "data") {
        term.write(event.data);
      } else if (event.type === "exit") {
        termIdRef.current = null;
        showStatus(event.code === 0 ? "Terminal closed" : `Process exited with code ${event.code}`);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (termIdRef.current == null) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      void window.piBridge.terminal.resize(termIdRef.current, term.cols, term.rows);
    });
    resizeObserver.observe(container);

    disposeRef.current = () => {
      disposed = true;
      resizeObserver.disconnect();
      offEvent();
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
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

  // Create on first visible; refit + focus whenever the panel becomes visible.
  useEffect(() => {
    if (!active) return;
    ensureCreated();
    const frame = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (term && fit) {
        try {
          fit.fit();
        } catch {
          /* container may be hidden */
        }
        if (termIdRef.current != null) {
          void window.piBridge.terminal.resize(termIdRef.current, term.cols, term.rows);
        }
        term.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, ensureCreated]);

  // A changed directory means a new shell: tear the old one down so the next
  // visible pass creates a fresh session.
  useEffect(() => {
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
