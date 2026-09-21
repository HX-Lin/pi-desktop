/**
 * Jev settings: channels first, then each consumer's knobs.
 *
 * The channel section is what everything else depends on — which gateway, which
 * model, and where the key comes from — so it leads, and a live probe proves the
 * whole path (key, protocol, model slug) before any feature is switched on.
 */
import { useCallback, useEffect, useState } from "react";
import type { JevConfigPayload, JevSettingsPayload, JevTestResult } from "@shared/api-types";
import { useI18n } from "@/i18n";
import { jevGetConfig, jevSetKey, jevTest, jevUpdateConfig } from "@/lib/api-client";

export function JevConfig() {
  const { t } = useI18n();
  const [config, setConfig] = useState<JevConfigPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last key/test failure, shown next to the field that caused it. */
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<JevTestResult | null>(null);

  const load = useCallback(async () => {
    try {
      setConfig(await jevGetConfig());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(async (patch: unknown) => {
    setBusy(true);
    setTest(null);
    try {
      setConfig(await jevUpdateConfig(patch));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveKey = useCallback(async () => {
    setBusy(true);
    setTest(null);
    setKeyError(null);
    try {
      setConfig(await jevSetKey(keyDraft));
      setKeyDraft("");
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Shown next to the field as well: the shared error line sits at the very
      // bottom of this page, below three long sections.
      setKeyError(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [keyDraft]);

  const runTest = useCallback(async () => {
    setBusy(true);
    setTest(null);
    setKeyError(null);
    try {
      setTest(await jevTest());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setKeyError(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!config) {
    return <Section title={t("jevTitle", "Jev")}>{error ?? t("loading", "Loading…")}</Section>;
  }

  const settings = config.settings;
  const channel = config.channel;

  return (
    <div style={{ width: "100%", overflowY: "auto", padding: "28px clamp(18px, 5vw, 52px)" }}>
      <Section
        title={t("jevTitle", "Jev")}
        description={t(
          "jevDescription",
          "Jev answers typed probability questions: it can gate tool calls, compact the context window, and pick a model per turn. Everything here is off until you switch it on.",
        )}
      >
        <Row label={t("jevEnabled", "Enable Jev")}>
          <Checkbox checked={settings.enabled} disabled={busy} onChange={(value) => void update({ enabled: value })} />
        </Row>
      </Section>

      <Divider />

      <Section
        title={t("jevChannel", "Channel")}
        description={t(
          "jevChannelDescription",
          "Where the judgments are sent. TypeSafe and OpenRouter speak Jev's native decisions protocol; Vercel AI Gateway is called through its OpenAI-compatible chat endpoint.",
        )}
      >
        <Row label={t("jevProvider", "Provider")}>
          <select
            value={settings.channel}
            disabled={busy}
            onChange={(event) => void update({ channel: event.target.value })}
            style={selectStyle}
          >
            {config.channels.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label={t("jevProtocol", "Protocol")}>
          <span style={valueStyle}>
            {channel.protocol === "chat"
              ? t("jevProtocolChat", "chat/completions (JSON)")
              : t("jevProtocolDecisions", "decisions (native)")}
          </span>
        </Row>

        <Row label={t("jevEndpoint", "Endpoint")}>
          <input
            defaultValue={channel.baseUrl}
            disabled={busy}
            placeholder={channel.defaultBaseUrl || "https://host/v1/chat/completions"}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== (channel.baseUrl ?? "")) void update({ baseUrl: value || null });
            }}
            style={inputStyle}
            spellCheck={false}
          />
        </Row>

        <Row label={t("jevModel", "Model")}>
          <input
            defaultValue={channel.model}
            disabled={busy}
            placeholder={channel.defaultModel || "model-name"}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== (channel.model ?? "")) void update({ model: value || null });
            }}
            style={inputStyle}
            spellCheck={false}
          />
        </Row>
        <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "2px 0 0" }}>
          {t("jevDefaultsHint", "这两项留空即恢复该通道的默认值（上面显示的就是默认值）；手填过的值会一直覆盖它。")}
        </p>
      </Section>

      <Divider />

      <Section
        title={t("jevKey", "API key")}
        description={t(
          "jevKeyDescription",
          "Stored encrypted in this app's credential vault. An environment variable wins over the stored key.",
        )}
      >
        <Row label={t("jevKeySource", "In use")}>
          <span style={valueStyle}>
            {channel.keySource === "env"
              ? t("jevKeyFromEnv", "environment: {name}").replace("{name}", channel.keyVariable ?? "")
              : channel.keySource === "vault"
                ? t("jevKeyFromVault", "stored in the vault")
                : t("jevKeyMissing", "no key configured")}
          </span>
        </Row>
        <Row label={t("jevKeyNew", "Set key")}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="password"
              value={keyDraft}
              placeholder={channel.keyHint}
              onChange={(event) => setKeyDraft(event.target.value)}
              style={inputStyle}
              spellCheck={false}
            />
            <button type="button" onClick={() => void saveKey()} disabled={busy} style={buttonStyle}>
              {keyDraft.trim() ? t("save", "Save") : t("jevKeyClear", "Clear")}
            </button>
          </div>
        </Row>
        <Row label={t("jevTest", "Connection")}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
            <button type="button" onClick={() => void runTest()} disabled={busy || !channel.hasKey} style={buttonStyle}>
              {t("jevTestRun", "Test")}
            </button>
            <span style={{ ...valueStyle, color: test && !test.ok ? "#ef4444" : "var(--text-muted)" }}>
              {test
                ? test.ok
                  ? t("jevTestOk", "answered {probability} in {ms} ms ({model})")
                      .replace("{probability}", (test.probability ?? 0).toFixed(2))
                      .replace("{ms}", String(test.latencyMs ?? 0))
                      .replace("{model}", test.model ?? "?")
                  : `${test.reason ?? "error"}: ${test.message ?? ""}`
                : channel.hasKey
                  ? t("jevTestIdle", "Not tested yet")
                  : t("jevTestNoKey", "Save a key first")}
            </span>
          </div>
        </Row>
        {keyError ? <p style={{ color: "#ef4444", fontSize: 12, margin: "2px 0 0" }}>{keyError}</p> : null}
      </Section>

      <Divider />

      <GateSection settings={settings} rules={config.rules} busy={busy} hasKey={channel.hasKey} onUpdate={update} />

      <Divider />

      <CompactionSection settings={settings} busy={busy} onUpdate={update} />

      <Divider />

      <RoutingSection settings={settings} busy={busy} onUpdate={update} />

      {error ? <p style={{ color: "#ef4444", fontSize: 12, marginTop: 14 }}>{error}</p> : null}
    </div>
  );
}

/** One row per gate condition, with its calibrated default and the override. */
function GateSection({
  settings,
  rules,
  busy,
  hasKey,
  onUpdate,
}: {
  settings: JevSettingsPayload;
  rules: JevConfigPayload["rules"];
  busy: boolean;
  hasKey: boolean;
  onUpdate: (patch: unknown) => Promise<void>;
}) {
  const { t } = useI18n();
  const gate = settings.gate;
  const patchGate = (patch: Record<string, unknown>) => onUpdate({ gate: { ...gate, ...patch } });
  const [thresholdDraft, setThresholdDraft] = useState<Record<string, string>>({});

  return (
    <Section
      title={t("jevGate", "Permission gate")}
      description={t(
        "jevGateDescription",
        "Judges bash, write and edit calls before they run, in every session (including messaging channels). The deterministic layer runs first; only what it cannot vouch for reaches Jev, and anything that cannot be judged is blocked.",
      )}
    >
      <Row label={t("jevGateEnabled", "Gate tool calls")}>
        <Checkbox checked={gate.enabled} disabled={busy} onChange={(value) => void patchGate({ enabled: value })} />
      </Row>
      {gate.enabled && !hasKey ? (
        // Enabling the gate without a working key makes every call it cannot
        // vouch for fail closed — including the assistant's own commands, which
        // leaves no way to set the key from inside the app.
        <p style={{ color: "#f59e0b", fontSize: 12, margin: "2px 0 0" }}>
          {t(
            "jevGateNoKeyWarning",
            "还没有可用密钥：闸门无法判断，会拦截一切未被确定性规则担保的调用（包括让助手执行命令）。请先保存密钥，或把范围改为「只判断已识别的危险形状」。",
          )}
        </p>
      ) : null}
      <Row label={t("jevGateScope", "Scope")}>
        <select
          value={gate.scope}
          disabled={busy}
          onChange={(event) => void patchGate({ scope: event.target.value })}
          style={selectStyle}
        >
          <option value="all">{t("jevScopeAll", "Judge everything unvouched for (recommended)")}</option>
          <option value="matched">{t("jevScopeMatched", "Only recognised dangerous shapes")}</option>
        </select>
      </Row>
      <Row label={t("jevGateUncertain", "Middle band")}>
        <select
          value={gate.uncertain}
          disabled={busy}
          onChange={(event) => void patchGate({ uncertain: event.target.value })}
          style={selectStyle}
        >
          <option value="deny">{t("jevUncertainDeny", "Block")}</option>
          <option value="ask">{t("jevUncertainAsk", "Ask me (blocks where no dialog exists)")}</option>
          <option value="allow">{t("jevUncertainAllow", "Allow")}</option>
        </select>
      </Row>
      <Row label={t("jevGateTimeout", "Per-attempt timeout (ms)")}>
        <input
          type="number"
          min={500}
          max={60_000}
          defaultValue={gate.timeoutMs}
          disabled={busy}
          onBlur={(event) => void patchGate({ timeoutMs: Number(event.target.value) })}
          style={{ ...inputStyle, maxWidth: 120 }}
        />
      </Row>

      <ListField
        label={t("jevSafeCommands", "Commands that run silently")}
        hint={t(
          "jevSafeCommandsHint",
          "One glob per line. Use for commands that are safe on this machine (a test runner runs your code).",
        )}
        values={gate.safeCommands}
        busy={busy}
        onCommit={(values) => void patchGate({ safeCommands: values })}
      />
      <ListField
        label={t("jevAllowedCommands", "Allow patterns (recorded)")}
        hint={t("jevAllowedCommandsHint", "Overrides a dangerous-shape match; the override is recorded.")}
        values={gate.allowedCommands}
        busy={busy}
        onCommit={(values) => void patchGate({ allowedCommands: values })}
      />
      <ListField
        label={t("jevDisallowedCommands", "Deny patterns")}
        hint={t(
          "jevDisallowedCommandsHint",
          "Blocked before Jev is asked. Patterns never match commands with shell control syntax.",
        )}
        values={gate.disallowedCommands}
        busy={busy}
        onCommit={(values) => void patchGate({ disallowedCommands: values })}
      />
      <ListField
        label={t("jevExtraProtectedPaths", "Extra protected paths")}
        hint={t("jevExtraProtectedPathsHint", "Writes here are judged even inside the project.")}
        values={gate.extraProtectedPaths}
        busy={busy}
        onCommit={(values) => void patchGate({ extraProtectedPaths: values })}
      />
      <Row label={t("jevPolicyNotes", "Policy the gate must respect")}>
        <textarea
          defaultValue={gate.policyNotes}
          disabled={busy}
          rows={3}
          placeholder={t("jevPolicyNotesPlaceholder", "e.g. never push to main; ask before installing dependencies")}
          onBlur={(event) => void patchGate({ policyNotes: event.target.value })}
          style={textareaStyle}
        />
      </Row>

      <div style={{ marginTop: 6 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("jevThresholds", "Condition thresholds")} ·{" "}
          {t(
            "jevThresholdsHint",
            "p at or above the threshold satisfies a condition; at or below 1−threshold rejects it. The band between is the middle band.",
          )}
        </span>
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {rules.map((rule) => {
            const value = gate.thresholds[rule.id] ?? rule.threshold;
            const draft = thresholdDraft[rule.id] ?? String(value);
            return (
              <div key={rule.id} style={ruleRowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "var(--text)" }}>
                    {rule.id} · {rule.label}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                    {rule.mode} / {rule.severity} · {t("jevRuleDefault", "default")} {rule.threshold}
                  </div>
                </div>
                <input
                  type="number"
                  min={0.51}
                  max={1}
                  step={0.005}
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setThresholdDraft((prev) => ({ ...prev, [rule.id]: event.target.value }))}
                  onBlur={() => {
                    const parsed = Number(draft);
                    const next = { ...gate.thresholds };
                    // A threshold must keep a middle band: out-of-range input is
                    // dropped rather than clamped into a meaningless value.
                    if (!Number.isFinite(parsed) || parsed <= 0.5 || parsed > 1) delete next[rule.id];
                    else next[rule.id] = parsed;
                    void patchGate({ thresholds: next });
                  }}
                  style={{ ...inputStyle, maxWidth: 110 }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

function CompactionSection({
  settings,
  busy,
  onUpdate,
}: {
  settings: JevSettingsPayload;
  busy: boolean;
  onUpdate: (patch: unknown) => Promise<void>;
}) {
  const { t } = useI18n();
  const compaction = settings.compaction;
  const patch = (next: Record<string, unknown>) => onUpdate({ compaction: { ...compaction, ...next } });
  const numberField = (label: string, key: keyof typeof compaction, min: number, max: number, step = 0.05) => (
    <Row label={label}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={compaction[key] as number}
        disabled={busy}
        onBlur={(event) => void patch({ [key]: Number(event.target.value) })}
        style={{ ...inputStyle, maxWidth: 140 }}
      />
    </Row>
  );

  return (
    <Section
      title={t("jevCompaction", "Context compaction")}
      description={t(
        "jevCompactionDescription",
        "Only for pi's own context compaction (the window filling up, or /compact). It keeps user and assistant text verbatim, drops obsolete tool calls and bounds long results. “Compact to memory” keeps using this app's own distillation.",
      )}
    >
      <Row label={t("jevCompactionEnabled", "Use Jev for context compaction")}>
        <Checkbox checked={compaction.enabled} disabled={busy} onChange={(value) => void patch({ enabled: value })} />
      </Row>
      {numberField(t("jevKeepThreshold", "Keep threshold"), "keepThreshold", 0, 1)}
      {numberField(t("jevBorderline", "Borderline band"), "borderline", 0, 0.5)}
      {numberField(t("jevTruncateHead", "Result head kept (chars)"), "truncateHeadChars", 0, 10_000, 10)}
      {numberField(t("jevMinReduction", "Minimum reduction"), "minReduction", 0, 0.95)}
      {numberField(t("jevMaxStateTokens", "State budget (tokens)"), "maxStateTokens", 1000, 400_000, 1000)}
      {numberField(t("jevMaxRequestTokens", "Request budget (tokens)"), "maxRequestTokens", 1000, 400_000, 1000)}
    </Section>
  );
}

function RoutingSection({
  settings,
  busy,
  onUpdate,
}: {
  settings: JevSettingsPayload;
  busy: boolean;
  onUpdate: (patch: unknown) => Promise<void>;
}) {
  const { t } = useI18n();
  const routing = settings.routing;
  const patch = (next: Record<string, unknown>) => onUpdate({ routing: { ...routing, ...next } });
  const textField = (label: string, key: keyof typeof routing) => (
    <Row label={label}>
      <input
        defaultValue={(routing[key] as string | null) ?? ""}
        disabled={busy}
        placeholder="provider/model-id:thinking"
        onBlur={(event) => {
          const value = event.target.value.trim();
          void patch({ [key]: value ? value : null });
        }}
        style={inputStyle}
        spellCheck={false}
      />
    </Row>
  );

  return (
    <Section
      title={t("jevRouting", "Model routing")}
      description={t(
        "jevRoutingDescription",
        "An independent mode: when it is on, Jev rates each request and a confidently easy or hard one switches model before the turn. Everything else — including any failure — keeps the model you picked.",
      )}
    >
      <Row label={t("jevRoutingMode", "Mode")}>
        <select
          value={routing.mode}
          disabled={busy}
          onChange={(event) => void patch({ mode: event.target.value })}
          style={selectStyle}
        >
          <option value="off">{t("jevRoutingOff", "Off (use the model I pick)")}</option>
          <option value="jev">{t("jevRoutingOn", "Jev decides per turn")}</option>
        </select>
      </Row>
      {textField(t("jevRoutingCheap", "Easy requests"), "cheap")}
      {textField(t("jevRoutingStrong", "Hard requests"), "strong")}
      {textField(t("jevRoutingCheapThinking", "Easy thinking level"), "cheapThinking")}
      {textField(t("jevRoutingStrongThinking", "Hard thinking level"), "strongThinking")}
      <Row label={t("jevRoutingEasyMax", "Easy at or below")}>
        <input
          type="number"
          min={0}
          max={2}
          step={0.5}
          defaultValue={routing.easyMax}
          disabled={busy}
          onBlur={(event) => void patch({ easyMax: Number(event.target.value) })}
          style={{ ...inputStyle, maxWidth: 120 }}
        />
      </Row>
      <Row label={t("jevRoutingHardMin", "Hard at or above")}>
        <input
          type="number"
          min={0}
          max={2}
          step={0.5}
          defaultValue={routing.hardMin}
          disabled={busy}
          onBlur={(event) => void patch({ hardMin: Number(event.target.value) })}
          style={{ ...inputStyle, maxWidth: 120 }}
        />
      </Row>
      <Row label={t("jevRoutingMinConfidence", "Minimum confidence")}>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          defaultValue={routing.minConfidence}
          disabled={busy}
          onBlur={(event) => void patch({ minConfidence: Number(event.target.value) })}
          style={{ ...inputStyle, maxWidth: 120 }}
        />
      </Row>
    </Section>
  );
}

/** A newline-separated list, committed on blur so typing stays cheap. */
function ListField({
  label,
  hint,
  values,
  busy,
  onCommit,
}: {
  label: string;
  hint: string;
  values: string[];
  busy: boolean;
  onCommit: (values: string[]) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{label}</span>
        <span style={{ fontSize: 10, color: "var(--text-dim)", textAlign: "right", maxWidth: 340 }}>{hint}</span>
      </div>
      <textarea
        defaultValue={values.join("\n")}
        disabled={busy}
        rows={3}
        onBlur={(event) =>
          onCommit(
            event.target.value
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          )
        }
        style={textareaStyle}
        spellCheck={false}
      />
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section style={{ maxWidth: 640, marginBottom: 6 }}>
      <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{title}</h2>
      {description ? (
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>{description}</p>
      ) : null}
      <div style={{ display: "grid", gap: 8 }}>{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        minHeight: 46,
        padding: "8px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <span style={{ fontSize: 13, color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
      <div style={{ minWidth: 0, display: "flex", justifyContent: "flex-end", flex: 1 }}>{children}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "var(--border)", maxWidth: 640, margin: "26px 0" }} />;
}

function Checkbox({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      style={{ width: 16, height: 16, margin: 0, accentColor: "var(--accent)", cursor: "pointer" }}
    />
  );
}

const textareaStyle = {
  width: "100%",
  minWidth: 0,
  padding: "6px 10px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  lineHeight: 1.5,
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  resize: "vertical",
} as const;

const ruleRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  padding: "6px 12px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-panel)",
} as const;

const selectStyle = {
  padding: "6px 10px",
  fontSize: 12,
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  maxWidth: 320,
} as const;

const inputStyle = {
  flex: 1,
  minWidth: 0,
  padding: "6px 10px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
} as const;

const valueStyle = { fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" } as const;

const buttonStyle = {
  flexShrink: 0,
  padding: "6px 12px",
  fontSize: 12,
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
} as const;

export type { JevSettingsPayload };
