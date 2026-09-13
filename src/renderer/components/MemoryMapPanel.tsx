/**
 * Visual map of what the app is holding for a session.
 *
 * Two layers, drawn the same way — one tile per unit, sized by weight, coloured
 * by kind, recessed when it is no longer in the model's context:
 *
 *   - memory: sections of the distilled memory, its scripts, what sank into the
 *     archive, and the raw conversation removed by a compaction
 *   - context: the map Accordion serves for this session, when it is installed
 *
 * Clicking a tile inspects it. Nothing here mutates anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccordionSessionStatus, AccordionStatus, MemoryOverview } from "@shared/api-types";
import { useI18n } from "@/i18n";
import { accordionStatus, memoryOverview } from "@/lib/api-client";

interface MemoryMapPanelProps {
  sessionId: string | null;
  cwd: string | null;
  onClose: () => void;
  /** Open a URL in the app's own browser dock. */
  onOpenUrl?: (url: string) => void;
}

type Tab = "memory" | "context";

export function MemoryMapPanel({ sessionId, cwd, onClose, onOpenUrl }: MemoryMapPanelProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("memory");
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [accordion, setAccordion] = useState<AccordionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Tile | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setOverview(null);
      return;
    }
    setLoading(true);
    setError(null);
    const [memory, maps] = await Promise.allSettled([memoryOverview(sessionId), accordionStatus()]);
    if (memory.status === "fulfilled") setOverview(memory.value);
    else setError(memory.reason instanceof Error ? memory.reason.message : String(memory.reason));
    setAccordion(maps.status === "fulfilled" ? maps.value : { running: false, sessions: [] });
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tiles = useMemo(() => buildTiles(overview, t), [overview, t]);
  const liveAccounts = useMemo(
    () => (accordion?.sessions ?? []).slice().sort((left, right) => Number(right.live) - Number(left.live)),
    [accordion],
  );

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("memoryMap", "Memory map")}
        onClick={(event) => event.stopPropagation()}
        style={dialogStyle}
      >
        <header style={headerStyle}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("memoryMap", "Memory map")}</span>
          <div style={{ display: "flex", gap: 2 }}>
            {(["memory", "context"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                style={{
                  ...ghostButtonStyle,
                  color: tab === value ? "var(--text)" : "var(--text-dim)",
                  borderColor: tab === value ? "var(--accent)" : "var(--border)",
                }}
              >
                {value === "memory" ? t("memoryTab", "Memory") : t("contextTab", "Context")}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {overview?.exists ? (
            <button
              type="button"
              onClick={() => void window.piBridge.showItemInFolder(overview.dir)}
              style={ghostButtonStyle}
            >
              {t("openMemoryFolder", "Open folder")}
            </button>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            style={ghostButtonStyle}
            aria-label={t("close", "Close")}
          >
            ✕
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 18px" }}>
          {loading && <Hint>{t("loading", "Loading…")}</Hint>}
          {error && <Hint tone="error">{error}</Hint>}

          {tab === "memory" && !loading && !error && overview && !overview.exists && (
            <Hint>
              {t("memoryEmpty", "This session has no memory yet. It appears after the first “compact to memory”.")}
            </Hint>
          )}

          {tab === "memory" && overview?.exists && (
            <>
              <Tally tiles={tiles} overview={overview} />
              <TileGrid tiles={tiles} selected={selected} onSelect={setSelected} />
              <Inspector tile={selected} />
            </>
          )}

          {tab === "context" && (
            <ContextTab
              sessions={liveAccounts}
              cwd={cwd}
              onOpenUrl={onOpenUrl}
              hasMemory={Boolean(overview?.exists)}
              memoryPath={overview?.primary?.path}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

type TileTone = "goal" | "constraint" | "progress" | "decision" | "context" | "script" | "fact" | "sunk" | "archive";

interface Tile {
  key: string;
  label: string;
  sublabel: string;
  body: string;
  bytes: number;
  weight: number;
  tone: TileTone;
  inert: boolean;
}

const TONES: Record<TileTone, { bg: string; border: string; fg: string }> = {
  goal: {
    bg: "color-mix(in srgb, var(--accent) 24%, transparent)",
    border: "color-mix(in srgb, var(--accent) 55%, transparent)",
    fg: "var(--text)",
  },
  constraint: { bg: "rgba(139,92,246,0.20)", border: "rgba(139,92,246,0.45)", fg: "var(--text)" },
  progress: { bg: "rgba(20,184,166,0.20)", border: "rgba(20,184,166,0.45)", fg: "var(--text)" },
  decision: { bg: "rgba(245,158,11,0.20)", border: "rgba(245,158,11,0.45)", fg: "var(--text)" },
  context: { bg: "rgba(100,116,139,0.22)", border: "rgba(100,116,139,0.45)", fg: "var(--text)" },
  script: { bg: "rgba(34,197,94,0.22)", border: "rgba(34,197,94,0.5)", fg: "var(--text)" },
  fact: { bg: "rgba(249,115,22,0.20)", border: "rgba(249,115,22,0.45)", fg: "var(--text)" },
  sunk: { bg: "rgba(100,116,139,0.12)", border: "rgba(100,116,139,0.3)", fg: "var(--text-dim)" },
  archive: { bg: "rgba(100,116,139,0.10)", border: "rgba(100,116,139,0.28)", fg: "var(--text-dim)" },
};

/** Section title → visual class, so the map reads at a glance. */
function sectionTone(title: string): TileTone {
  const text = title.toLowerCase();
  if (/脚本|script/.test(text)) return "script";
  if (/事实|fact|error|报错/.test(text)) return "fact";
  if (/目标|goal|objective|request/.test(text)) return "goal";
  if (/约束|偏好|constraint|preference|requirement/.test(text)) return "constraint";
  if (/进度|完成|progress|done|next|下一步|待办|todo/.test(text)) return "progress";
  if (/决策|决定|decision|rationale/.test(text)) return "decision";
  return "context";
}

function buildTiles(overview: MemoryOverview | null, t: (key: string, fallback: string) => string): Tile[] {
  if (!overview?.exists) return [];
  const tiles: Tile[] = [];
  const maxBytes = Math.max(
    1,
    ...(overview.primary?.sections ?? []).map((section) => section.bytes),
    ...(overview.scripts ?? []).map((script) => script.bytes),
  );

  // A memory whose scanned slice has no headings still deserves a tile.
  if (overview.primary && overview.primary.sections.length === 0 && overview.primary.bytes > 0) {
    tiles.push({
      key: "p:whole",
      label: t("memoryActive", "Active memory"),
      sublabel: formatBytes(overview.primary.bytes),
      body: "",
      bytes: overview.primary.bytes,
      weight: 3,
      tone: "goal",
      inert: false,
    });
  }

  for (const section of overview.primary?.sections ?? []) {
    tiles.push({
      key: `p:${section.title}`,
      label: section.title,
      sublabel: formatBytes(section.bytes),
      body: section.preview,
      bytes: section.bytes,
      weight: weightOf(section.bytes, maxBytes),
      tone: sectionTone(section.title),
      inert: false,
    });
  }

  for (const script of overview.scripts ?? []) {
    tiles.push({
      key: `s:${script.name}`,
      label: script.name,
      sublabel: formatBytes(script.bytes),
      body: script.description,
      bytes: script.bytes,
      weight: 1,
      tone: "script",
      inert: false,
    });
  }

  if (overview.secondary && overview.secondary.sections.length === 0 && overview.secondary.bytes > 0) {
    tiles.push({
      key: "x:whole",
      label: t("memorySunk", "Sunk memory"),
      sublabel: formatBytes(overview.secondary.bytes),
      body: "",
      bytes: overview.secondary.bytes,
      weight: 2,
      tone: "sunk",
      inert: true,
    });
  }

  for (const section of overview.secondary?.sections ?? []) {
    tiles.push({
      key: `x:${section.title}`,
      label: section.title,
      sublabel: formatBytes(section.bytes),
      body: section.preview,
      bytes: section.bytes,
      weight: 1,
      tone: "sunk",
      inert: true,
    });
  }

  for (const file of overview.archives ?? []) {
    tiles.push({
      key: `a:${file.name}`,
      label: file.name.slice(0, 10),
      sublabel: formatBytes(file.bytes),
      body: file.name,
      bytes: file.bytes,
      weight: 1,
      tone: "archive",
      inert: true,
    });
  }

  return tiles.sort((left, right) => right.bytes - left.bytes);
}

/** Dice-face style weight: 1–3 grid cells, on a log scale against the largest tile. */
function weightOf(bytes: number, maxBytes: number): number {
  if (bytes <= 0) return 1;
  const ratio = Math.log2(1 + bytes) / Math.log2(1 + maxBytes);
  if (ratio > 0.78) return 3;
  if (ratio > 0.5) return 2;
  return 1;
}

function TileGrid({
  tiles,
  selected,
  onSelect,
}: {
  tiles: Tile[];
  selected: Tile | null;
  onSelect: (tile: Tile) => void;
}) {
  if (tiles.length === 0) return null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))",
        gridAutoRows: "72px",
        gap: 6,
        marginBottom: 14,
      }}
    >
      {tiles.map((tile) => {
        const tone = TONES[tile.tone];
        const active = selected?.key === tile.key;
        return (
          <button
            key={tile.key}
            type="button"
            onClick={() => onSelect(tile)}
            title={`${tile.label} · ${formatBytes(tile.bytes)}`}
            style={{
              gridColumn: `span ${tile.weight}`,
              gridRow: `span ${tile.weight}`,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: 2,
              padding: "6px 8px",
              textAlign: "left",
              background: tone.bg,
              border: `1px solid ${active ? "var(--accent)" : tone.border}`,
              borderRadius: 8,
              outline: active ? "2px solid color-mix(in srgb, var(--accent) 45%, transparent)" : "none",
              color: tone.fg,
              cursor: "pointer",
              overflow: "hidden",
              opacity: tile.inert ? 0.72 : 1,
              backgroundImage: tile.inert
                ? "repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 4px, transparent 4px 8px)"
                : undefined,
            }}
          >
            <span
              style={{
                fontSize: 11,
                lineHeight: 1.3,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: tile.weight > 1 ? 4 : 2,
                WebkitBoxOrient: "vertical",
                wordBreak: "break-word",
              }}
            >
              {tile.tone === "script" ? "▶ " : ""}
              {tile.label}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
              {tile.sublabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Tally({ tiles, overview }: { tiles: Tile[]; overview: MemoryOverview }) {
  const live = tiles.filter((tile) => !tile.inert);
  const items: Array<[string, string]> = [
    ["in context", `${live.length} · ${formatBytes(overview.primary?.bytes ?? 0)}`],
    ["scripts", String(overview.scripts.length)],
    ["sunk", overview.secondary ? formatBytes(overview.secondary.bytes) : "—"],
    ["removed", `${overview.archives.length} · ${formatBytes(overview.archivesBytes)}`],
  ];
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
      {items.map(([label, value]) => (
        <div key={label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>
            {label}
          </span>
          <span style={{ fontSize: 12, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
      ))}
      <span style={{ flex: 1 }} />
      {overview.secondary?.tailOnly ? (
        <span style={{ alignSelf: "flex-end", fontSize: 10, color: "var(--text-dim)" }}>newest slice only</span>
      ) : null}
    </div>
  );
}

function Inspector({ tile }: { tile: Tile | null }) {
  const { t } = useI18n();
  if (!tile) return null;
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-subtle)",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--text)" }}>{tile.label}</span>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{formatBytes(tile.bytes)}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
          {tile.inert ? t("notInContext", "not in context") : t("inContext", "in context")}
        </span>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          maxHeight: 240,
          overflow: "auto",
          fontSize: 11,
          lineHeight: 1.55,
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {tile.body || "—"}
      </pre>
    </section>
  );
}

function ContextTab({
  sessions,
  cwd,
  onOpenUrl,
  hasMemory,
  memoryPath,
}: {
  sessions: AccordionSessionStatus[];
  cwd: string | null;
  onOpenUrl?: (url: string) => void;
  hasMemory: boolean;
  memoryPath?: string;
}) {
  const { t } = useI18n();
  const live = sessions.filter((session) => session.live);
  const preferred = live.find((session) => session.cwd === cwd) ?? live[0];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <section>
        <h3 style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
          {t("contextAccordion", "Accordion context map")}
        </h3>
        <p style={{ margin: "6px 0 10px", fontSize: 11, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t(
            "contextAccordionHint",
            "Accordion (pi extension) serves a live map of the context window: every block sized by weight, coloured by kind, foldable and reversible. The desktop app opens that map in its own browser panel.",
          )}
        </p>
        {!hasMemory && <Hint>{t("contextNoMemory", "This session has no memory yet.")}</Hint>}
        {live.length === 0 ? (
          <Hint>
            {t(
              "contextNoAccordion",
              "No live Accordion map. Install it with `pi install npm:@a-fig/accordion`, restart, then run /accordion in the session to print the map link.",
            )}
          </Hint>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {preferred && onOpenUrl ? (
              <button type="button" onClick={() => onOpenUrl(preferred.url)} style={primaryButtonStyle}>
                {t("contextOpen", "Open map in app")} · 127.0.0.1:{preferred.port}
              </button>
            ) : null}
            {sessions.map((session) => (
              <div
                key={session.sessionId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 10px",
                  fontSize: 11,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg-subtle)",
                  opacity: session.live ? 1 : 0.55,
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{session.port}</span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--text-muted)",
                  }}
                >
                  {session.cwd ?? session.sessionId}
                </span>
                <span style={{ color: "var(--text-dim)" }}>
                  {session.tokens ? `${session.tokens.toLocaleString()} tok` : (session.model ?? "")}
                </span>
                <span style={{ color: session.live ? "var(--accent)" : "var(--text-dim)" }}>
                  {session.live ? t("live", "live") : t("stale", "stale")}
                </span>
              </div>
            ))}
            <p style={{ margin: 0, fontSize: 10, lineHeight: 1.6, color: "var(--text-dim)" }}>
              {t(
                "contextTokenHint",
                "First visit needs the token link printed by /accordion; it is remembered as a cookie afterwards.",
              )}
            </p>
          </div>
        )}
      </section>

      {memoryPath ? (
        <section>
          <h3 style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>{t("contextMemoryFile", "Memory file")}</h3>
          <code
            style={{
              display: "block",
              marginTop: 6,
              padding: "6px 8px",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              background: "var(--bg-subtle)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              overflowWrap: "anywhere",
            }}
          >
            {memoryPath}
          </code>
        </section>
      ) : null}
    </div>
  );
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <p
      style={{
        margin: "0 0 12px",
        fontSize: 12,
        lineHeight: 1.6,
        color: tone === "error" ? "#ef4444" : "var(--text-dim)",
      }}
    >
      {children}
    </p>
  );
}

const overlayStyle = {
  position: "absolute",
  inset: 0,
  zIndex: 90,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  background: "rgba(0,0,0,0.18)",
} as const;

const dialogStyle = {
  width: "100%",
  maxWidth: 780,
  maxHeight: "82vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxShadow: "0 18px 48px rgba(0,0,0,0.22)",
  overflow: "hidden",
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
} as const;

const ghostButtonStyle = {
  flexShrink: 0,
  padding: "4px 10px",
  fontSize: 11,
  color: "var(--text-muted)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
} as const;

const primaryButtonStyle = {
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "#fff",
  background: "var(--accent)",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  justifySelf: "start",
} as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
