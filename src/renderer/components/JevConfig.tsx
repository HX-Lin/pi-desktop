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
    try {
      setConfig(await jevSetKey(keyDraft));
      setKeyDraft("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [keyDraft]);

  const runTest = useCallback(async () => {
    setBusy(true);
    setTest(null);
    try {
      setTest(await jevTest());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value && value !== channel.baseUrl) void update({ baseUrl: value });
            }}
            style={inputStyle}
            spellCheck={false}
          />
        </Row>

        <Row label={t("jevModel", "Model")}>
          <input
            defaultValue={channel.model}
            disabled={busy}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value && value !== channel.model) void update({ model: value });
            }}
            style={inputStyle}
            spellCheck={false}
          />
        </Row>
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
                : t("jevTestIdle", "Not tested yet")}
            </span>
          </div>
        </Row>
      </Section>

      {error ? <p style={{ color: "#ef4444", fontSize: 12, marginTop: 14 }}>{error}</p> : null}
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
