/**
 * Native map of the context window, driven by the vendored fold engine.
 *
 * Every block of the live context is a tile: sized by its weight, coloured by
 * kind, recessed once folded, with the protected working tail marked. Clicking a
 * tile inspects it and offers fold / unfold / pin, which is the same op
 * vocabulary the engine applies to an agent `unfold` or a conductor's proposal.
 *
 * Folding is off until the user arms it, so this doubles as a read-only view of
 * what the model is actually being sent.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContextBlockView, ContextFoldCommand, ContextFoldResult, ContextMapSnapshot } from "@shared/api-types";
import { useI18n } from "@/i18n";
import { contextFold, contextMap } from "@/lib/api-client";

interface ContextFoldMapProps {
  sessionId: string | null;
  /** Bumped by the chat whenever the context likely changed. */
  refreshKey?: number;
}

const KIND_TONES: Record<string, { bg: string; border: string }> = {
  system: { bg: "rgba(100,116,139,0.16)", border: "rgba(100,116,139,0.4)" },
  user: {
    bg: "color-mix(in srgb, var(--accent) 24%, transparent)",
    border: "color-mix(in srgb, var(--accent) 55%, transparent)",
  },
  text: { bg: "rgba(59,130,246,0.18)", border: "rgba(59,130,246,0.42)" },
  thinking: { bg: "rgba(168,85,247,0.18)", border: "rgba(168,85,247,0.42)" },
  tool_call: { bg: "rgba(245,158,11,0.18)", border: "rgba(245,158,11,0.42)" },
  tool_result: { bg: "rgba(20,184,166,0.18)", border: "rgba(20,184,166,0.42)" },
};

export function ContextFoldMap({ sessionId, refreshKey = 0 }: ContextFoldMapProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ContextMapSnapshot | null>(null);
  const [selected, setSelected] = useState<ContextBlockView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) {
      setSnapshot(null);
      return;
    }
    try {
      const next = await contextMap(sessionId);
      setSnapshot(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const send = useCallback(
    async (command: ContextFoldCommand) => {
      if (!sessionId) return;
      setBusy(true);
      try {
        const result: ContextFoldResult = await contextFold(sessionId, command);
        setSnapshot(result.snapshot);
        setSelected((current) => result.snapshot.blocks.find((block) => block.id === current?.id) ?? null);
        setError(result.refused.length > 0 ? result.refused.map((entry) => entry.reason).join(", ") : null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  const tiles = useMemo(() => snapshot?.blocks ?? [], [snapshot]);

  if (!sessionId) {
    return <Hint>{t("contextNoSession", "Open a session to see its context.")}</Hint>;
  }
  if (!snapshot) {
    return <Hint>{error ?? t("loading", "Loading…")}</Hint>;
  }
  if (snapshot.blocks.length === 0) {
    return <Hint>{t("contextEmpty", "This session has no messages in context yet.")}</Hint>;
  }

  const { stats } = snapshot;
  const overBudget = stats.budget > 0 && stats.liveTokens > stats.budget;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void send({ action: "folding", enabled: !snapshot.folding })}
          disabled={busy}
          style={{
            ...toggleStyle,
            background: snapshot.folding ? "var(--accent)" : "transparent",
            borderColor: snapshot.folding ? "var(--accent)" : "var(--border)",
            color: snapshot.folding ? "#fff" : "var(--text-muted)",
          }}
        >
          {snapshot.folding ? t("foldingOn", "Folding on") : t("foldingOff", "Folding off")}
        </button>
        <button
          type="button"
          onClick={() => void send({ action: "reset" })}
          disabled={busy || stats.foldedCount === 0}
          style={{ ...toggleStyle, opacity: stats.foldedCount === 0 ? 0.5 : 1 }}
        >
          {t("unfoldAll", "Unfold all")}
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: overBudget ? "#f59e0b" : "var(--text-dim)" }}>
          {t("liveTokens", "context")} {stats.liveTokens.toLocaleString()} / {stats.fullTokens.toLocaleString()} tok
          {stats.savedTokens > 0 ? ` · ${t("savedTokens", "saved")} ${stats.savedTokens.toLocaleString()}` : ""}
          {stats.budget > 0 ? ` · ${t("budget", "budget")} ${stats.budget.toLocaleString()}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Metric label={t("blocks", "blocks")} value={String(stats.blockCount)} />
        <Metric label={t("foldedBlocks", "folded")} value={String(stats.foldedCount)} />
        <Metric
          label={t("contextWindow", "window")}
          value={stats.contextWindow ? `${Math.round((stats.liveTokens / stats.contextWindow) * 100)}%` : "—"}
        />
        <Metric label={t("protectedTail", "protected tail")} value={`${stats.protectTokens.toLocaleString()} tok`} />
      </div>

      {tiles.length === 0 ? null : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
            gridAutoRows: "64px",
            gap: 5,
          }}
        >
          {tiles.map((block) => {
            const tone = KIND_TONES[block.kind] ?? KIND_TONES.text;
            const active = selected?.id === block.id;
            return (
              <button
                key={block.id}
                type="button"
                onClick={() => setSelected(block)}
                title={`${block.label} · ${block.tokens} tok${block.folded ? ` · ${block.digest}` : ""}`}
                style={{
                  gridColumn: `span ${weightOf(block.fullTokens)}`,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: 2,
                  padding: "5px 7px",
                  textAlign: "left",
                  background: block.folded ? "rgba(100,116,139,0.10)" : tone.bg,
                  border: `1px solid ${active ? "var(--accent)" : block.protectedBlock ? "rgba(245,158,11,0.45)" : tone.border}`,
                  borderRadius: 7,
                  color: block.folded ? "var(--text-dim)" : "var(--text)",
                  cursor: "pointer",
                  overflow: "hidden",
                  opacity: block.folded ? 0.85 : 1,
                  backgroundImage: block.folded
                    ? "repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 4px, transparent 4px 8px)"
                    : undefined,
                  outline: active ? "2px solid color-mix(in srgb, var(--accent) 45%, transparent)" : "none",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    lineHeight: 1.3,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    wordBreak: "break-word",
                  }}
                >
                  {block.pinned ? "📌 " : ""}
                  {block.label}
                </span>
                <span style={{ fontSize: 9, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
                  {block.tokens} tok
                </span>
              </button>
            );
          })}
        </div>
      )}

      {snapshot.truncated ? <Hint>{t("contextTruncated", "Showing the most recent blocks only.")}</Hint> : null}

      {selected ? (
        <section style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-subtle)",
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--text)" }}>{selected.label}</span>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              {selected.tokens} / {selected.fullTokens} tok
            </span>
            {selected.folded ? <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{selected.digest}</span> : null}
            <span style={{ flex: 1 }} />
            {selected.folded ? (
              <button
                type="button"
                onClick={() => void send({ action: "unfold", ids: [selected.id] })}
                style={actionStyle}
              >
                {t("unfoldBlock", "Unfold")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send({ action: "fold", ids: [selected.id] })}
                disabled={!selected.foldable || busy}
                style={{ ...actionStyle, opacity: selected.foldable ? 1 : 0.5 }}
                title={selected.foldable ? undefined : t("cannotFold", "This block cannot be folded")}
              >
                {t("foldBlock", "Fold")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void send({ action: selected.pinned ? "unpin" : "pin", ids: [selected.id] })}
              style={actionStyle}
            >
              {selected.pinned ? t("unpinBlock", "Unpin") : t("pinBlock", "Pin")}
            </button>
          </div>
          <pre style={previewStyle}>{selected.preview || "—"}</pre>
        </section>
      ) : null}

      {error ? <Hint tone="error">{error}</Hint> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </span>
      <span style={{ fontSize: 12, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
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

/** Dice-face weight: heavier blocks claim more grid cells. */
function weightOf(tokens: number): number {
  if (tokens > 4000) return 3;
  if (tokens > 800) return 2;
  return 1;
}

const toggleStyle = {
  padding: "5px 12px",
  fontSize: 11,
  color: "var(--text-muted)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
} as const;

const actionStyle = {
  padding: "3px 10px",
  fontSize: 11,
  color: "var(--text)",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  cursor: "pointer",
} as const;

const previewStyle = {
  margin: 0,
  padding: "10px 12px",
  maxHeight: 220,
  overflow: "auto",
  fontSize: 11,
  lineHeight: 1.55,
  fontFamily: "var(--font-mono)",
  color: "var(--text-muted)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
} as const;
