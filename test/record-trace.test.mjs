import { execFile } from "node:child_process";
import { globSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const CLI = join(import.meta.dirname, "..", "record-trace.mjs");
const hasChrome =
  process.env.CHROME ||
  globSync(
    [
      ".cache/puppeteer/chrome/*/*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ".cache/puppeteer/chrome/linux-*/chrome-linux64/chrome",
    ].map((p) => join(homedir(), p)),
  ).length;

const record = async (...extra) => {
  const dir = mkdtempSync(join(tmpdir(), "record-trace-"));
  const out = join(dir, "trace.json");
  await promisify(execFile)(
    "node",
    [
      CLI,
      "--headless",
      "--url",
      "data:text/html,<h1>hi</h1>",
      "--seconds",
      "1",
      "--out",
      out,
      ...extra,
    ],
    {
      env: { ...process.env, PORT: "9333", PROFILE: join(dir, "profile") },
      timeout: 60_000,
    },
  );
  return JSON.parse(readFileSync(out, "utf8"));
};

describe("record-trace", { skip: !hasChrome && "Chrome for Testing not installed" }, () => {
  it("should write a trace DevTools can load", async () => {
    const trace = await record();
    assert.ok(trace.traceEvents.some((e) => e.name === "TracingStartedInBrowser"));
  });

  it("should embed a sourceMaps array into metadata with --source-maps", async () => {
    const trace = await record("--source-maps");
    assert.ok(Array.isArray(trace.metadata.sourceMaps));
  });
});
