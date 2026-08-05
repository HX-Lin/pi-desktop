import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { PromptRecord, PromptScope } from "../../shared/api-types";

interface Props {
  cwd: string;
  onClose: () => void;
  embedded?: boolean;
}

function displayPath(filePath: string, cwd: string, scope: PromptScope): string {
  if (scope === "project" && filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length).replace(/^[/\\]/, "");
    return `.pi/prompts/${rel}`;
  }
  return filePath;
}

function templateContent(name: string): string {
  return `---
description: ${name} prompt
argument-hint:
---

You are an expert at ${name}. Use this template when invoked with \`/${name}\`.

Available arguments: $1, $2, $@ (or \${1:-default}).
`;
}

export function PromptsConfig({ cwd, onClose, embedded = false }: Props) {
  const { t } = useI18n();
  const [project, setProject] = useState<PromptRecord[]>([]);
  const [globalPrompts, setGlobalPrompts] = useState<PromptRecord[]>([]);
  const [projectDir, setProjectDir] = useState("");
  const [globalDir, setGlobalDir] = useState("");
  const [scope, setScope] = useState<PromptScope>("project");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editor state
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [contentLoading, setContentLoading] = useState(false);
  const [contentSaving, setContentSaving] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  // New-file state
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const newNameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/prompts?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then(
        (d: {
          project?: PromptRecord[];
          global?: PromptRecord[];
          projectDir?: string;
          globalDir?: string;
          error?: string;
        }) => {
          if (d.error) {
            setError(d.error);
            return;
          }
          setProject(d.project ?? []);
          setGlobalPrompts(d.global ?? []);
          setProjectDir(d.projectDir ?? "");
          setGlobalDir(d.globalDir ?? "");
          const list = scope === "project" ? (d.project ?? []) : (d.global ?? []);
          if (list.length > 0 && !list.some((p) => p.filePath === selected)) {
            setSelected(list[0].filePath);
          }
        },
      )
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cwd, scope, selected]);

  useEffect(() => {
    load();
  }, [cwd, scope]); // eslint-disable-line react-hooks/exhaustive-deps -- reload on project/scope change.

  const list = scope === "project" ? project : globalPrompts;

  // Load selected file content
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setContentLoading(true);
    setContentError(null);
    fetch("/api/prompts/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: scope === "project" ? cwd : undefined, scope, filePath: selected }),
    })
      .then((r) => r.json())
      .then((d: { content?: string; error?: string }) => {
        if (cancelled) return;
        if (d.error) {
          setContentError(d.error);
          setContent("");
          setSavedContent("");
          return;
        }
        setContent(d.content ?? "");
        setSavedContent(d.content ?? "");
      })
      .catch((e) => {
        if (!cancelled) setContentError(String(e));
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, scope, cwd]);

  const save = useCallback(
    async (filePath: string, nextContent: string) => {
      setContentSaving(true);
      setContentError(null);
      try {
        const res = await fetch("/api/prompts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: scope === "project" ? cwd : undefined,
            scope,
            filePath,
            content: nextContent,
          }),
        });
        const d = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || d.error) {
          setContentError(d.error ?? `HTTP ${res.status}`);
          return false;
        }
        setSavedContent(nextContent);
        return true;
      } catch (e) {
        setContentError(String(e));
        return false;
      } finally {
        setContentSaving(false);
      }
    },
    [scope, cwd],
  );

  const remove = useCallback(
    async (filePath: string) => {
      if (!window.confirm(t("promptDeleteConfirm", "Delete this prompt file?"))) return;
      setContentError(null);
      try {
        const res = await fetch("/api/prompts", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: scope === "project" ? cwd : undefined, scope, filePath }),
        });
        const d = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || d.error) {
          setContentError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        if (selected === filePath) setSelected(null);
        load();
      } catch (e) {
        setContentError(String(e));
      }
    },
    [scope, cwd, selected, load, t],
  );

  const create = useCallback(async () => {
    const name = newName.trim().replace(/\.md$/i, "").replace(/[\\/]/g, "-");
    if (!name) return;
    const root = scope === "project" ? projectDir : globalDir;
    if (!root) return;
    const target = `${root.replace(/[\\/]$/, "")}/${name}.md`;
    const ok = await save(target, templateContent(name));
    if (ok) {
      setAdding(false);
      setNewName("");
      load();
      setSelected(target);
    }
  }, [newName, scope, projectDir, globalDir, save, load]);

  const scopeDir = scope === "project" ? projectDir || `${cwd}/.pi/prompts/` : globalDir || "~/.pi/agent/prompts/";
  const selectedRecord = list.find((p) => p.filePath === selected) ?? null;

  return (
    <div
      style={
        embedded
          ? { position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex" }
          : {
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              background: "rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }
      }
      onClick={(e) => {
        if (!embedded && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: embedded ? "100%" : 860,
          maxWidth: embedded ? undefined : "calc(100vw - 16px)",
          height: embedded ? "100%" : "78vh",
          maxHeight: embedded ? undefined : "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: embedded ? "none" : "1px solid var(--border)",
          borderRadius: embedded ? 0 : 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: embedded ? "none" : "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{t("prompts", "Prompts")}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.6 }}>
            {t(
              "promptsDescription",
              "Prompt templates are markdown files in the prompts folder. The file name is the template name — type /name in chat to use it. Front matter: description, argument-hint. Arguments: $1, $2, $@.",
            )}
          </div>
        </div>

        {/* Scope tabs */}
        <div style={{ display: "flex", gap: 4, padding: "8px 18px 0", borderBottom: "1px solid var(--border)" }}>
          {(
            [
              { id: "project", label: t("promptProject", "Project prompts") },
              { id: "global", label: t("promptGlobal", "System prompts") },
            ] as { id: PromptScope; label: string }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setScope(tab.id)}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                borderRadius: "6px 6px 0 0",
                border: "none",
                background: scope === tab.id ? "var(--bg-panel)" : "transparent",
                color: scope === tab.id ? "var(--text)" : "var(--text-dim)",
                fontWeight: scope === tab.id ? 600 : 400,
                cursor: "pointer",
                borderBottom: scope === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              {tab.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--text-dim)", alignSelf: "center", paddingBottom: 8 }}>
            {scopeDir}
          </span>
        </div>

        {error ? (
          <div style={{ padding: 16, color: "#f87171", fontSize: 13 }}>{error}</div>
        ) : (
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            {/* File list */}
            <div
              style={{
                width: 240,
                flexShrink: 0,
                borderRight: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
              <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
                {loading ? (
                  <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>
                    {t("promptsLoading", "Loading…")}
                  </div>
                ) : list.length === 0 ? (
                  <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>
                    {t("promptsEmpty", "No prompts yet — create one below.")}
                  </div>
                ) : (
                  list.map((prompt) => (
                    <button
                      key={prompt.filePath}
                      type="button"
                      onClick={() => setSelected(prompt.filePath)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 10px",
                        borderRadius: 6,
                        border: "none",
                        background: selected === prompt.filePath ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                        marginBottom: 2,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{prompt.name}</div>
                      {prompt.description && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-dim)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {prompt.description}
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
              <div style={{ padding: 8, borderTop: "1px solid var(--border)" }}>
                {adding ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input
                      ref={newNameRef}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void create();
                        if (e.key === "Escape") setAdding(false);
                      }}
                      placeholder={t("promptNamePlaceholder", "name (creates name.md)")}
                      spellCheck={false}
                      autoFocus
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "6px 8px",
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        background: "var(--bg-panel)",
                        color: "var(--text)",
                        outline: "none",
                      }}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => void create()}
                        disabled={!newName.trim()}
                        style={{
                          flex: 1,
                          padding: "6px 0",
                          fontSize: 12,
                          borderRadius: 5,
                          border: "none",
                          background: "var(--accent)",
                          color: "#fff",
                          cursor: newName.trim() ? "pointer" : "default",
                          opacity: newName.trim() ? 1 : 0.5,
                        }}
                      >
                        {t("promptCreate", "Create")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAdding(false)}
                        style={{
                          padding: "6px 10px",
                          fontSize: 12,
                          borderRadius: 5,
                          border: "1px solid var(--border)",
                          background: "var(--bg-panel)",
                          color: "var(--text-dim)",
                          cursor: "pointer",
                        }}
                      >
                        {t("promptCancel", "Cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(true);
                      setTimeout(() => newNameRef.current?.focus(), 0);
                    }}
                    style={{
                      width: "100%",
                      padding: "7px 0",
                      fontSize: 12,
                      borderRadius: 6,
                      border: "1px dashed var(--border)",
                      background: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    + {t("promptNew", "New prompt")}
                  </button>
                )}
              </div>
            </div>

            {/* Editor */}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: 14, gap: 8 }}>
              {contentLoading ? (
                <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
                  {t("promptsLoadingFile", "Loading file…")}
                </div>
              ) : selectedRecord ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)" }}>
                      {selectedRecord.name}.md
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 5px",
                        borderRadius: 3,
                        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
                        color: scope === "project" ? "rgba(99,102,241,0.8)" : "var(--text-dim)",
                      }}
                    >
                      {scope === "project" ? t("promptProject", "Project") : t("promptGlobal", "System")}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-dim)",
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayPath(selectedRecord.filePath, cwd, scope)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(selectedRecord.filePath)}
                      style={{
                        padding: "4px 9px",
                        fontSize: 11,
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        background: "var(--bg-panel)",
                        color: "#f87171",
                        cursor: "pointer",
                      }}
                    >
                      {t("promptDelete", "Delete")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void save(selectedRecord.filePath, content)}
                      disabled={contentSaving || content === savedContent}
                      style={{
                        minHeight: 28,
                        padding: "0 11px",
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        background: content !== savedContent ? "var(--accent)" : "var(--bg-panel)",
                        color: content !== savedContent ? "#fff" : "var(--text-dim)",
                        cursor: contentSaving || content === savedContent ? "default" : "pointer",
                        fontSize: 12,
                      }}
                    >
                      {contentSaving ? "Saving…" : t("promptSave", "Save")}
                    </button>
                  </div>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    spellCheck={false}
                    aria-label="Prompt markdown content"
                    style={{
                      flex: 1,
                      minHeight: 0,
                      resize: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                      padding: 12,
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      lineHeight: 1.55,
                      outline: "none",
                    }}
                  />
                  {contentError && <span style={{ fontSize: 11, color: "#f87171" }}>{contentError}</span>}
                </>
              ) : (
                <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
                  {t("promptsSelectPrompt", "Select a prompt to edit it.")}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
