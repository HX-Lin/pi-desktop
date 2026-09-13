/**
 * Read-only overview of what "压缩为记忆" has stored for the active session.
 *
 * The chat only shows the distilled memory inline, which says nothing about the
 * two tiers behind it — memory that sank into the archive, raw conversation that
 * was removed, and the executable scripts. This panel is where that becomes
 * visible without leaving the app.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryOverview, MemoryTextOverview } from "@shared/api-types";
import { useI18n } from "@/i18n";
import { memoryOverview } from "@/lib/api-client";

interface MemoryOverviewPanelProps {
  sessionId: string | null;
  onClose: () => void;
}

export function MemoryOverviewPanel({ sessionId, onClose }: MemoryOverviewPanelProps) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSecondary, setShowSecondary] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!sessionId) {
      setOverview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void memoryOverview(sessionId)
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openDir = useCallback(() => {
    if (overview?.exists) void window.piBridge.showItemInFolder(overview.dir);
  }, [overview]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("memoryOverview", "Memory overview")}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 760,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 18px 48px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            {t("memoryOverview", "Memory overview")}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sessionId ?? ""}
          </span>
          <button
            type="button"
            onClick={openDir}
            disabled={!overview?.exists}
            style={buttonStyle(Boolean(overview?.exists))}
          >
            {t("openMemoryFolder", "Open folder")}
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            style={buttonStyle(true)}
            aria-label={t("close", "Close")}
          >
            ✕
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 18px" }}>
          {loading && <Hint>{t("loading", "Loading…")}</Hint>}
          {error && <Hint tone="error">{error}</Hint>}
          {!loading && !error && overview && !overview.exists && (
            <Hint>
              {t("memoryEmpty", "This session has no memory yet. It appears after the first “compact to memory”.")}
            </Hint>
          )}
          {overview?.exists && (
            <>
              <Section title={t("memoryActive", "Active memory")} subtitle={t("memoryActiveHint", "in context")}>
                <TextBlock text={overview.primary} empty={t("memoryNoPrimary", "No active memory file yet")} />
              </Section>

              <Section
                title={t("memorySunk", "Sunk memory")}
                subtitle={t("memorySunkHint", "not in context — search it on demand")}
              >
                {overview.secondary ? (
                  <div>
                    <Row>
                      <PathLine path={overview.secondary.path} bytes={overview.secondary.bytes} />
                      <button
                        type="button"
                        onClick={() => setShowSecondary((value) => !value)}
                        style={buttonStyle(true)}
                      >
                        {showSecondary ? t("hide", "Hide") : t("preview", "Preview")}
                      </button>
                    </Row>
                    {showSecondary && (
                      <>
                        <Sections sections={overview.secondary.sections} />
                        <Preview text={overview.secondary.preview} note={t("memoryNewestPart", "newest part")} />
                      </>
                    )}
                  </div>
                ) : (
                  <Hint>{t("memoryNoSunk", "Nothing has sunk out of the active memory.")}</Hint>
                )}
              </Section>

              <Section
                title={t("memoryArchives", "Removed conversation")}
                subtitle={t("memoryArchivesHint", "raw entries kept before deletion")}
              >
                {overview.archives.length === 0 ? (
                  <Hint>{t("memoryNoArchives", "No raw conversation has been removed yet.")}</Hint>
                ) : (
                  <>
                    <Hint>
                      {t("memoryArchiveTotal", "{count} files · {size}")
                        .replace("{count}", String(overview.archives.length))
                        .replace("{size}", formatBytes(overview.archivesBytes))}
                    </Hint>
                    <ul style={listStyle}>
                      {overview.archives.map((file) => (
                        <li key={file.name} style={listItemStyle}>
                          <code style={monoStyle}>{file.name}</code>
                          <span style={{ color: "var(--text-dim)" }}>{formatBytes(file.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Section>

              <Section
                title={t("memoryScripts", "Memory scripts")}
                subtitle={t("memoryScriptsHint", "runnable procedures, never in context")}
              >
                {overview.scripts.length === 0 ? (
                  <Hint>{t("memoryNoScripts", "No scripts have been sedimented yet.")}</Hint>
                ) : (
                  <ul style={listStyle}>
                    {overview.scripts.map((script) => (
                      <li key={script.name} style={listItemStyle}>
                        <code style={monoStyle}>{script.name}</code>
                        <span style={{ flex: 1, minWidth: 0, color: "var(--text-muted)" }}>{script.description}</span>
                        <span style={{ color: "var(--text-dim)" }}>{formatBytes(script.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TextBlock({ text, empty }: { text: MemoryTextOverview | null; empty: string }) {
  if (!text) return <Hint>{empty}</Hint>;
  return (
    <div>
      <Row>
        <PathLine path={text.path} bytes={text.bytes} updatedAt={text.updatedAt} />
      </Row>
      <Sections sections={text.sections} />
      <Preview text={text.preview} />
    </div>
  );
}

function Sections({ sections }: { sections: string[] }) {
  if (sections.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0" }}>
      {sections.map((section) => (
        <span
          key={section}
          style={{
            padding: "2px 8px",
            fontSize: 11,
            color: "var(--text-muted)",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            borderRadius: 999,
          }}
        >
          {section}
        </span>
      ))}
    </div>
  );
}

function Preview({ text, note }: { text: string; note?: string }) {
  if (!text.trim()) return null;
  return (
    <pre
      style={{
        margin: "6px 0 0",
        padding: "10px 12px",
        maxHeight: 220,
        overflow: "auto",
        fontSize: 11,
        lineHeight: 1.55,
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
        background: "var(--bg-subtle)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
      {note ? `\n\n— ${note}` : ""}
    </pre>
  );
}

function PathLine({ path, bytes, updatedAt }: { path: string; bytes: number; updatedAt?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
      <code
        style={{
          ...monoStyle,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={path}
      >
        {path}
      </code>
      <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatBytes(bytes)}</span>
      {updatedAt ? (
        <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{new Date(updatedAt).toLocaleString()}</span>
      ) : null}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13, color: "var(--text)" }}>{title}</h3>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{subtitle}</span>
      </div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>{children}</div>;
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return <p style={{ margin: 0, fontSize: 12, color: tone === "error" ? "#ef4444" : "var(--text-dim)" }}>{children}</p>;
}

function buttonStyle(enabled: boolean) {
  return {
    flexShrink: 0,
    padding: "4px 10px",
    fontSize: 11,
    color: enabled ? "var(--text-muted)" : "var(--text-dim)",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.5,
  } as const;
}

const listStyle = { margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 4 } as const;
const listItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
  fontSize: 12,
  color: "var(--text-muted)",
} as const;
const monoStyle = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" } as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
