/**
 * Session-level context folding, built on the vendored Accordion engine.
 *
 * The engine in `vendor/accordion/core` decides *what* may be folded and how a
 * folded block looks on the wire; this module owns the pi-desktop side:
 *
 *   - one `Truth` per live session, rebuilt from pi's own messages each turn so
 *     overlays always follow the real context (compaction, fork, tree nav)
 *   - the `context` hook: with folding armed, the departing wire is rebuilt from
 *     the Truth; otherwise messages pass through untouched
 *   - the fold/unfold/pin controls the UI drives, and the read-only snapshot the
 *     map renders
 *
 * Folding is OFF by default, exactly like upstream: the map is a viewer until the
 * user arms it. Nothing here throws into the model call — every failure falls back
 * to passthrough.
 */
import type {
  ContextBlockKind,
  ContextBlockView,
  ContextFoldCommand,
  ContextFoldResult,
  ContextMapSnapshot,
} from "../shared/api-types";
import { blockLabel, resolveRecall, resolveUnfold } from "./vendor/accordion/core/agentView";
import type { Op } from "./vendor/accordion/core/ops";
import { Truth } from "./vendor/accordion/core/truth";
import type { Block } from "./vendor/accordion/core/types";
import { linearize, wireToBlock, type PiMessage } from "./vendor/accordion/core/wire";

/** The map is a viewer: bounding it keeps a huge session cheap to render. */
const MAX_VIEW_BLOCKS = 400;
const PREVIEW_CHARS = 240;

export class FoldSession {
  private truth: Truth | null = null;
  private sessionId = "";
  private contextWindow: number | null = null;
  private protectTokens: number | undefined;
  /** True once the user arms folding for this session. */
  folding = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Rebuild the engine from the messages pi is about to send. */
  observe(
    messages: PiMessage[],
    options: { contextWindow?: number | null; protectTokens?: number; systemPrompt?: string } = {},
  ): void {
    try {
      if (typeof options.contextWindow === "number" && options.contextWindow > 0) {
        this.contextWindow = options.contextWindow;
      }
      if (typeof options.protectTokens === "number" && options.protectTokens > 0) {
        this.protectTokens = options.protectTokens;
      }
      const previous = this.truth;
      const blocks = linearize(messages).map(wireToBlock);
      const truth = Truth.rebuildFrom(previous, {
        meta: { format: "pi", title: "session", cwd: "", model: "" },
        blocks,
        lineCount: 0,
        skipped: 0,
      });
      truth.wireAttached = true;
      if (this.contextWindow != null) truth.setContextWindow(this.contextWindow);
      if (this.protectTokens !== undefined) truth.setProtect(this.protectTokens);
      if (typeof options.systemPrompt === "string") {
        truth.setSystemPrompt(options.systemPrompt, Math.ceil(options.systemPrompt.length / 4));
      }
      this.truth = truth;
    } catch (error) {
      // Never let a fold-engine failure break a model call.
      console.error("[pi-desktop] context fold observe failed:", error instanceof Error ? error.message : error);
      this.truth = null;
    }
  }

  /** The messages to send, folded when armed. Errors fall back to passthrough. */
  serialize(messages: PiMessage[]): PiMessage[] | undefined {
    if (!this.folding || !this.truth) return undefined;
    try {
      return this.truth.serializeWire(messages);
    } catch (error) {
      console.error("[pi-desktop] context fold serialize failed:", error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  /** Align the protected tail with pi's own keep-recent budget. */
  setProtectTokens(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.protectTokens = tokens;
    try {
      this.truth?.setProtect(tokens);
    } catch {
      // Ignored: the value is applied on the next rebuild.
    }
  }

  /** Folding target: the map shows how far the live wire is from it. */
  setBudget(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    try {
      this.truth?.setBudget(Math.round(tokens));
    } catch {
      // Ignored.
    }
  }

  apply(ops: Op[], actor: "you" | "auto" | "agent" = "you"): ContextFoldResult {
    const refused: Array<{ id: string; reason: string }> = [];
    let applied = 0;
    try {
      const result = this.truth?.apply(ops, actor);
      for (const outcome of result?.results ?? []) {
        if (outcome.applied) applied += 1;
        if (outcome.clamped) {
          refused.push({ id: firstIdOf(outcome.op), reason: outcome.clamped });
        }
        for (const perId of outcome.perId ?? []) {
          if (!perId.applied) refused.push({ id: perId.id, reason: perId.reason ?? "refused" });
        }
      }
    } catch (error) {
      console.error("[pi-desktop] context fold apply failed:", error instanceof Error ? error.message : error);
    }
    return { applied, refused, snapshot: this.snapshot() };
  }

  /** Agent `unfold`: folded blocks become standing-open. */
  unfoldCodes(codes: string[]): { restored: Array<{ code: string; label: string }>; missing: string[] } {
    if (!this.truth) return { restored: [], missing: codes };
    const result = resolveUnfold(this.truth, codes);
    return {
      restored: result.restored.map((entry) => ({ code: entry.code, label: entry.label })),
      missing: result.missing,
    };
  }

  /** Agent `recall`: read folded content without changing the view. */
  recallCodes(codes: string[]): { restored: Array<{ code: string; label: string; text: string }>; missing: string[] } {
    if (!this.truth) return { restored: [], missing: codes };
    const result = resolveRecall(this.truth, codes);
    return {
      restored: result.restored.map((entry) => ({ code: entry.code, label: entry.label, text: entry.text })),
      missing: result.missing,
    };
  }

  snapshot(): ContextMapSnapshot {
    const truth = this.truth;
    if (!truth) {
      return {
        sessionId: this.sessionId,
        folding: this.folding,
        stats: {
          rev: 0,
          liveTokens: 0,
          fullTokens: 0,
          savedTokens: 0,
          budget: 0,
          contextWindow: this.contextWindow,
          protectTokens: this.protectTokens ?? 0,
          blockCount: 0,
          foldedCount: 0,
          protectedFromIndex: -1,
        },
        blocks: [],
        truncated: false,
      };
    }

    const stats = truth.stats();
    const all = truth.blocks;
    const visible = all.slice(Math.max(0, all.length - MAX_VIEW_BLOCKS));
    return {
      sessionId: this.sessionId,
      folding: this.folding,
      stats: {
        rev: stats.rev,
        liveTokens: stats.liveTokens,
        fullTokens: stats.fullTokens,
        savedTokens: Math.max(0, stats.fullTokens - stats.liveTokens),
        budget: stats.budget,
        contextWindow: stats.contextWindow,
        protectTokens: stats.protectTokens,
        blockCount: stats.blockCount,
        foldedCount: truth.foldedCount(),
        protectedFromIndex: stats.protectedFromIndex,
      },
      blocks: visible.map((block) => this.viewOf(block)),
      truncated: all.length > visible.length,
    };
  }

  private viewOf(block: Block): ContextBlockView {
    const truth = this.truth!;
    const folded = truth.isFolded(block);
    return {
      id: block.id,
      kind: block.kind as ContextBlockKind,
      label: blockLabel(block),
      turn: block.turn,
      order: block.order,
      tokens: truth.effTokens(block),
      fullTokens: block.tokens,
      folded,
      pinned: block.override === "pinned",
      protectedBlock: truth.isProtected(block),
      foldable: truth.canFold(block),
      digest: folded ? truth.digestOf(block) : "",
      preview: block.text.slice(0, PREVIEW_CHARS),
    };
  }
}

/** The first id an op targets, for refusal reporting. */
function firstIdOf(op: Op): string {
  if ("ids" in op && Array.isArray(op.ids)) return op.ids[0] ?? "";
  if ("id" in op && typeof op.id === "string") return op.id;
  if ("groupId" in op && typeof op.groupId === "string") return op.groupId;
  return "";
}

const sessions = new Map<string, FoldSession>();

/** One engine per pi session, for the lifetime of the host process. */
export function getFoldSession(sessionId: string): FoldSession {
  let session = sessions.get(sessionId);
  if (!session) {
    session = new FoldSession(sessionId);
    sessions.set(sessionId, session);
  }
  return session;
}

export function dropFoldSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** An empty map for a session the engine has not seen yet. */
export function emptyFoldSnapshot(sessionId: string): ContextMapSnapshot {
  return {
    sessionId,
    folding: false,
    stats: {
      rev: 0,
      liveTokens: 0,
      fullTokens: 0,
      savedTokens: 0,
      budget: 0,
      contextWindow: null,
      protectTokens: 0,
      blockCount: 0,
      foldedCount: 0,
      protectedFromIndex: -1,
    },
    blocks: [],
    truncated: false,
  };
}

/** Snapshot for a session that was never observed (an empty map, not an error). */
export function peekFoldSession(sessionId: string): ContextMapSnapshot | null {
  return sessions.get(sessionId)?.snapshot() ?? null;
}

/** Run one steering command from the map. */
export function applyFoldCommand(sessionId: string, command: ContextFoldCommand): ContextFoldResult {
  const session = getFoldSession(sessionId);
  switch (command.action) {
    case "folding":
      session.folding = command.enabled;
      return { applied: 0, refused: [], snapshot: session.snapshot() };
    case "budget":
      session.setBudget(command.tokens);
      return { applied: 0, refused: [], snapshot: session.snapshot() };
    case "protect":
      session.setProtectTokens(command.tokens);
      return { applied: 0, refused: [], snapshot: session.snapshot() };
    case "reset":
      return session.apply([{ kind: "resetAll" }]);
    default:
      return session.apply([{ kind: command.action, ids: command.ids }]);
  }
}
