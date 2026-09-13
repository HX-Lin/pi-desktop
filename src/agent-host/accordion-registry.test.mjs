import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const accordionHome = mkdtempSync(path.join(tmpdir(), "pi-accordion-home-"));
process.env.ACCORDION_HOME = accordionHome;
process.once("exit", () => rmSync(accordionHome, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `accordion-registry-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "accordion-registry.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { pickAccordionSession, readAccordionStatus } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

const sessionsDir = path.join(accordionHome, ".accordion", "sessions");

function register(name, entry) {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path.join(sessionsDir, `${name}.json`), JSON.stringify(entry), "utf8");
}

test("no registry means Accordion is not running", () => {
  assert.deepEqual(readAccordionStatus(Date.now()), { running: false, sessions: [] });
});

test("live registrations expose the map URL; stale ones are marked", () => {
  const now = Date.now();
  register("s-1", {
    sessionId: "s-1",
    port: 24317,
    pid: 1,
    cwd: "/tmp/project-a",
    title: "pi session",
    model: "gpt-5.6-sol",
    tokens: 1234,
    contextWindow: 200000,
    startedAt: now - 60_000,
    heartbeatAt: now - 1_000,
  });
  register("s-2", {
    sessionId: "s-2",
    port: 24318,
    heartbeatAt: now - 5 * 60_000,
    cwd: "/tmp/project-b",
  });
  register("s-3", { sessionId: "s-3", port: 24319, heartbeatAt: now - 2_000, cwd: "/tmp/project-c" });
  register("broken", { sessionId: "s-4" });
  writeFileSync(path.join(sessionsDir, "not-json.json"), "{oops", "utf8");

  const status = readAccordionStatus(now);

  assert.equal(status.running, true);
  assert.deepEqual(
    status.sessions.map((session) => [session.sessionId, session.live]),
    [
      ["s-1", true],
      ["s-3", true],
      ["s-2", false],
    ],
  );
  assert.equal(status.sessions[0].url, "http://127.0.0.1:24317/");
  assert.equal(status.sessions[0].tokens, 1234);

  // The map for the project the user is looking at is preferred; a project whose
  // only map is stale, or one with no map at all, falls back to the freshest live
  // map rather than pointing at a dead port.
  assert.equal(pickAccordionSession(status, "/tmp/project-c")?.sessionId, "s-3");
  assert.equal(pickAccordionSession(status, "/tmp/project-b")?.sessionId, "s-1");
  assert.equal(pickAccordionSession(status, "/tmp/unknown")?.sessionId, "s-1");
});
