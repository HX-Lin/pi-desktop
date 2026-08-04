import { useEffect, useState } from "react";

/**
 * Custom titlebar window controls (minimize / maximize / close) shown at the
 * top-right corner. Hidden on macOS where the native traffic lights are used.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const platform = window.piBridge?.platform;

  useEffect(() => {
    if (platform === "darwin" || !window.piBridge?.windowControl) return;
    let mounted = true;
    void window.piBridge.windowControl
      .isMaximized()
      .then((value) => {
        if (mounted) setMaximized(value);
      })
      .catch(() => {});
    const off = window.piBridge.windowControl.onMaximizedChange((value) => {
      if (mounted) setMaximized(value);
    });
    return () => {
      mounted = false;
      off();
    };
  }, [platform]);

  if (platform === "darwin" || !window.piBridge?.windowControl) return null;

  const buttonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 46,
    height: 36,
    padding: 0,
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    transition: "background 0.1s, color 0.1s",
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        zIndex: 500,
        display: "flex",
        alignItems: "center",
        height: 36,
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        userSelect: "none",
      }}
    >
      <button
        type="button"
        onClick={() => void window.piBridge.windowControl.minimize()}
        title="Minimize"
        aria-label="Minimize"
        style={buttonStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => void window.piBridge.windowControl.toggleMaximize().then(setMaximized)}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        style={buttonStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        {maximized ? (
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="9" width="11" height="11" rx="1" />
            <path d="M9 4h10a1 1 0 0 1 1 1v10" />
          </svg>
        ) : (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="4" width="16" height="16" rx="1.5" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={() => void window.piBridge.windowControl.close()}
        title="Close"
        aria-label="Close"
        style={buttonStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "#d93025";
          e.currentTarget.style.color = "#ffffff";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="5" y1="5" x2="19" y2="19" />
          <line x1="19" y1="5" x2="5" y2="19" />
        </svg>
      </button>
    </div>
  );
}
