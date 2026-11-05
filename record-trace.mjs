#!/usr/bin/env node
// Record Chrome DevTools Performance traces over CDP, streamed to disk. See README.md.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, globSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const INSTALL = "cd ~/.cache/puppeteer && npx -y @puppeteer/browsers install chrome@canary";

const USAGE = `Record a Chrome DevTools Performance trace, streamed to disk.

Usage:
  record-trace [url] [chrome flags...]          interactive: Enter to start/stop
  record-trace --tab <text> --seconds 10        non-interactive

Options:
  --tab <text>        record the tab whose URL/title contains text (default: first tab)
  --seconds <n>       stop after n seconds (otherwise stop on SIGINT/SIGTERM)
  --url <url>         navigate the tab and wait for load before recording
  --scenario <file>   module \`export default async ({ send, waitFor }) => {}\`; stops when it resolves
  --init-script <js>  run in every frame before page scripts, for this run's navigations
  --throttle <n>      CPU throttling rate while recording (e.g. 4)
  --source-maps       embed source maps into trace metadata
  --selector-stats    include CSS selector stats
  --lean              skip script sources and screenshots (much smaller, metrics unaffected)
  --out <file>        output path (default ./trace-<timestamp>.json)
  -h, --help          show this help
  Any other argument is passed to Chrome (e.g. --headless).

Env:
  CHROME   Chrome binary (default: newest Chrome for Testing in ~/.cache/puppeteer)
  PORT     remote debugging port (default 9222); attaches if Chrome already listens there
  PROFILE  user data dir (default ~/.cdp-trace-chrome)

Chrome for Testing: ${INSTALL}`;

// DevTools Performance panel defaults + JS sampling
// (devtools-frontend front_end/models/trace/types/TraceEvents.ts DefaultCategories).
// Custom tracks: performance.mark/measure → blink.user_timing, console.timeStamp → devtools.timeline.
const CORE = [
  "-*",
  "blink.console",
  "blink.user_timing",
  "loading",
  "devtools.timeline",
  "v8.execute",
  "v8",
  "cppgc",
  "navigation",
  "rail",
  "disabled-by-default-devtools.target-rundown",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-devtools.v8-source-rundown",
  "disabled-by-default-layout_shift.debug",
  "disabled-by-default-v8.inspector",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-v8.cpu_profiler.hires",
  "disabled-by-default-lighthouse",
];
// Script sources + screenshots are most of the trace size; metrics and CPU profile don't need them.
const HEAVY = [
  "disabled-by-default-devtools.v8-source-rundown-sources",
  "disabled-by-default-devtools.screenshot",
];
const SELECTOR_STATS = [
  "disabled-by-default-blink.debug",
  "disabled-by-default-devtools.timeline.invalidationTracking",
];

const OPTIONS = {
  tab: { type: "string" },
  seconds: { type: "string" },
  url: { type: "string" },
  scenario: { type: "string" },
  "init-script": { type: "string" },
  throttle: { type: "string" },
  out: { type: "string" },
  "source-maps": { type: "boolean" },
  "selector-stats": { type: "boolean" },
  lean: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const TOGGLES = {
  s: ["selector-stats", "selector stats"],
  m: ["source-maps", "source maps"],
  t: ["throttle", "4x CPU", "4"],
};

const PORT = process.env.PORT ?? 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = process.env.PROFILE ?? join(homedir(), ".cdp-trace-chrome");

/**
 * Print an error and exit with code 1.
 *
 * @param {string} message
 * @returns {never}
 */
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a Chrome remote debugging endpoint answers on PORT.
 *
 * @returns {Promise<boolean>}
 */
const isUp = () =>
  fetch(`${BASE}/json/version`).then(
    (r) => r.ok,
    () => false,
  );

/**
 * Parse argv. Own options go to `opts`; every other token is passed through to Chrome.
 * Exits if a string option has no value.
 * @returns {{ opts: Record<string, string | boolean | undefined>, chromeArgs: string[] }}
 */
function parseCli() {
  const { values, tokens } = parseArgs({
    options: OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  for (const [name, { type }] of Object.entries(OPTIONS)) {
    const v = values[name];
    if (type === "string" && (v === true || v?.startsWith("--"))) {
      fail(`--${name} needs a value. See --help.`);
    }
  }
  const chromeArgs = tokens
    .filter((t) => t.kind === "positional" || (t.kind === "option" && !(t.name in OPTIONS)))
    .map((t) =>
      t.kind === "positional" ? t.value : t.rawName + (t.value === undefined ? "" : `=${t.value}`),
    );
  return { opts: values, chromeArgs };
}

/**
 * Resolve the Chrome binary: `CHROME` env, else the newest Chrome for Testing in ~/.cache/puppeteer.
 *
 * @returns {string | undefined}
 */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const patterns = [
    ".cache/puppeteer/chrome/*/*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ".cache/puppeteer/chrome/linux-*/chrome-linux64/chrome",
  ];
  const found = globSync(patterns.map((p) => join(homedir(), p)));
  return found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

/**
 * Attach to Chrome already listening on PORT, or spawn one and wait until it is up.
 * A spawned Chrome is killed when this process exits, and this process exits when Chrome does.
 *
 * @param {string[]} chromeArgs extra flags for a spawned Chrome
 */
async function launchOrAttach(chromeArgs) {
  if (await isUp()) {
    console.log(`Attached to Chrome already running on port ${PORT} (left running on exit)`);
    return;
  }
  const bin = findChrome();
  if (!bin) fail(`Chrome for Testing not found. Install: ${INSTALL}`);
  const chrome = spawn(
    bin,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...chromeArgs,
    ],
    { stdio: "ignore" },
  );
  chrome.on("exit", (code) => {
    console.log(`\nChrome exited (${code})`);
    process.exit(code === 0 ? 0 : 1);
  });
  process.on("exit", () => chrome.kill());
  for (let i = 0; !(await isUp()); i++) {
    if (i === 50) {
      console.log(
        `Still waiting for debugging port ${PORT} (port in use, or RemoteDebuggingAllowed policy — check chrome://policy). Chrome stays open; Ctrl+C to quit.`,
      );
    }
    await sleep(200);
  }
}

/**
 * Choose the tab to record: matched by `tab`, else asked interactively, else the first one.
 *
 * @param {string | undefined} tab case-insensitive substring of the tab's URL or title
 * @param {import("node:readline/promises").Interface | undefined} rl prompt; absent in non-interactive runs
 * @returns {Promise<{ title: string, url: string, webSocketDebuggerUrl: string }>}
 */
async function pickPage(tab, rl) {
  const all = await (await fetch(`${BASE}/json/list`)).json();
  const pages = all.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!pages.length) fail("No open tabs");
  const label = (p) => `${p.title} — ${p.url}`;
  if (tab) {
    const needle = tab.toLowerCase();
    const match = pages.find((p) => `${p.url} ${p.title}`.toLowerCase().includes(needle));
    return (
      match ??
      fail(`No tab matches "${tab}". Open tabs:\n${pages.map((p) => `  ${label(p)}`).join("\n")}`)
    );
  }
  if (!rl || pages.length === 1) return pages[0];
  pages.forEach((p, i) => console.log(`  [${i + 1}] ${label(p)}`));
  return pages[Number(await rl.question("Tab number: ")) - 1] ?? pages[0];
}

/**
 * Minimal CDP client over the tab's WebSocket. Keeps one listener per event name,
 * which is all this script needs. Exits if the connection closes.
 *
 * @param {string} wsUrl
 * @returns {Promise<{
 *   send: (method: string, params?: object) => Promise<any>,
 *   on: (method: string, fn: (params: any) => void) => () => void,
 *   waitFor: (method: string) => Promise<any>,
 * }>} `send` resolves with the command result; `on` returns an unsubscribe function;
 *   `waitFor` resolves with the params of the next matching event.
 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onclose = () =>
    fail("\nDevTools connection closed (tab closed, or RemoteDebuggingAllowed policy kicked in).");

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = ({ data }) => {
    const { id, error, result, method, params } = JSON.parse(data);
    if (!id) return listeners.get(method)?.(params);
    const { resolve, reject } = pending.get(id);
    pending.delete(id);
    error ? reject(new Error(error.message)) : resolve(result);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++nextId, { resolve, reject });
      ws.send(JSON.stringify({ id: nextId, method, params }));
    });
  const on = (method, fn) => {
    listeners.set(method, fn);
    return () => listeners.delete(method);
  };
  const waitFor = (method) =>
    new Promise((resolve) => {
      const off = on(method, (params) => {
        off();
        resolve(params);
      });
    });
  return { send, on, waitFor };
}

/**
 * Read a CDP IO stream to the end in 1 MB chunks, then close it.
 *
 * @param {string} handle
 * @param {(chunk: Buffer) => unknown} onChunk awaited before the next read
 */
async function readStream(handle, onChunk) {
  for (let eof = false; !eof;) {
    const res = await cdp.send("IO.read", { handle, size: 1 << 20 });
    await onChunk(Buffer.from(res.data, res.base64Encoded ? "base64" : "utf8"));
    eof = res.eof;
  }
  await cdp.send("IO.close", { handle });
}

/**
 * Write to a stream, waiting for `drain` when its buffer is full.
 *
 * @param {import("node:fs").WriteStream} out
 * @param {string | Buffer} chunk
 */
async function write(out, chunk) {
  if (!out.write(chunk)) await once(out, "drain");
}

/**
 * Collect the page's external source maps. Debugger is enabled only after recording,
 * so it adds no overhead to the trace.
 *
 * @returns {Promise<Map<string, string>>} source map URL -> script URL, resolved the way
 *   DevTools matches them when loading a trace
 */
async function listSourceMaps() {
  const maps = new Map();
  const off = cdp.on("Debugger.scriptParsed", ({ url, sourceMapURL }) => {
    if (
      !url ||
      !sourceMapURL ||
      sourceMapURL.startsWith("data:") ||
      url.startsWith("chrome-extension:")
    )
      return;
    try {
      maps.set(new URL(sourceMapURL, url).href, url);
    } catch {}
  });
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.disable");
  off();
  return maps;
}

/**
 * Fetch each source map through the browser (so cookies/auth apply, as in DevTools) and
 * write them as comma-separated `{ url, sourceMapUrl, sourceMap }` entries. Failures are skipped.
 *
 * @param {import("node:fs").WriteStream} out
 * @param {Map<string, string>} maps from {@link listSourceMaps}
 */
async function writeSourceMaps(out, maps) {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  let written = 0;
  for (const [sourceMapUrl, url] of maps) {
    process.stdout.write(`\rSource maps ${written + 1}/${maps.size}…`);
    try {
      const { resource } = await cdp.send("Network.loadNetworkResource", {
        frameId: frameTree.frame.id,
        url: sourceMapUrl,
        options: { disableCache: false, includeCredentials: true },
      });
      if (!resource.success || resource.httpStatusCode >= 400) {
        throw new Error(resource.netErrorName ?? `HTTP ${resource.httpStatusCode}`);
      }
      const parts = [];
      await readStream(resource.stream, (chunk) => parts.push(chunk));
      const map = JSON.parse(
        Buffer.concat(parts)
          .toString()
          .replace(/^\)\]\}'.*\n/, ""),
      );
      // sourcesContent is ~80% of map size and only needed to view original source.
      delete map.sourcesContent;
      const entry = JSON.stringify({ url, sourceMapUrl, sourceMap: map });
      await write(out, written++ ? `,${entry}` : entry);
    } catch (e) {
      console.warn(`\nSkipped ${sourceMapUrl}: ${e.message}`);
    }
  }
  console.log(`\rEmbedded ${written}/${maps.size} source maps`);
}

/**
 * Stream the trace to `file`. Chrome writes `{"traceEvents":[...],"metadata":{...}}`; the last
 * bytes are held back so source maps can be spliced into `metadata.sourceMaps` before the
 * closing braces. Warns if the file is too big for DevTools to load.
 *
 * @param {string} handle CDP stream from `Tracing.tracingComplete`
 * @param {string} file
 * @param {Map<string, string>} [maps] source maps to embed
 */
async function save(handle, file, maps) {
  const out = createWriteStream(file);
  let tail = Buffer.alloc(0);
  let bytes = 0;
  await readStream(handle, async (chunk) => {
    bytes += chunk.length;
    tail = Buffer.concat([tail, chunk]);
    await write(out, tail.subarray(0, -64));
    tail = tail.subarray(-64);
    process.stdout.write(`\rSaving… ${(bytes / 1e6).toFixed(1)} MB`);
  });

  const end = tail.toString("latin1").trimEnd();
  let head;
  if (maps && end.endsWith("}}")) {
    head = `${end.slice(0, -2)}${end.at(-3) === "{" ? "" : ","}"sourceMaps":[`;
  } else if (maps && end.endsWith("]}")) {
    head = `${end.slice(0, -1)},"metadata":{"sourceMaps":[`;
  } else if (maps) {
    console.warn("\nUnexpected trace ending, source maps not embedded");
  }
  if (head) {
    await write(out, Buffer.from(head, "latin1"));
    await writeSourceMaps(out, maps);
    await write(out, "]}}");
  } else {
    await write(out, tail);
  }

  out.end();
  await once(out, "finish");
  console.log(`\rSaved ${file} (${(out.bytesWritten / 1e6).toFixed(1)} MB)`);
  // DevTools reads the file into one string; V8 caps strings at ~536M chars.
  if (out.bytesWritten > 536e6) {
    console.warn(
      "Warning: file is over ~536 MB, DevTools will fail to load it. Record a shorter window.",
    );
  }
}

/**
 * Record one trace: start tracing (with CPU throttling if set), wait for `stopped`,
 * then save to `--out` or `./trace-<timestamp>.json`.
 *
 * @param {() => Promise<unknown>} stopped resolves when recording should stop
 */
async function record(stopped) {
  const categories = [
    ...CORE,
    ...(opts.lean ? [] : HEAVY),
    ...(opts["selector-stats"] ? SELECTOR_STATS : []),
  ];
  // Default 200 MB buffer fills in ~30s on a large web app (script sources alone can be ~150 MB).
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: { includedCategories: categories, traceBufferSizeInKb: 2_000_000 },
  });
  if (opts.throttle)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(opts.throttle) });
  try {
    await stopped();
  } finally {
    if (opts.throttle) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }

  const done = cdp.waitFor("Tracing.tracingComplete");
  await cdp.send("Tracing.end");
  const { stream, dataLossOccurred } = await done;
  if (dataLossOccurred) console.warn("Warning: trace buffer filled up, some events were dropped");

  const maps = opts["source-maps"] ? await listSourceMaps() : undefined;
  const file = opts.out ?? `trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(dirname(file), { recursive: true });
  await save(stream, file, maps);
}

const { opts, chromeArgs } = parseCli();
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
const auto = ["tab", "seconds", "url", "scenario"].some((k) => opts[k] !== undefined);

await launchOrAttach(chromeArgs);

const rl = auto ? undefined : createInterface({ input: process.stdin, output: process.stdout });
rl?.on("SIGINT", () => process.exit(0));
rl?.on("close", () => process.exit(0));
await rl?.question("Chrome is up. Open your page, then press Enter… ");

const page = await pickPage(opts.tab, rl);
console.log(`Using: ${page.title} — ${page.url}`);
const cdp = await connect(page.webSocketDebuggerUrl);

if (opts["init-script"]) {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: opts["init-script"] });
}
if (opts.url) {
  await cdp.send("Page.enable");
  const loaded = cdp.waitFor("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: opts.url });
  await loaded;
}

if (opts.scenario) {
  const { default: scenario } = await import(resolve(opts.scenario));
  console.log(`Recording scenario ${opts.scenario}…`);
  await record(() => scenario({ send: cdp.send, waitFor: cdp.waitFor }));
} else if (auto) {
  console.log(`Recording${opts.seconds ? ` for ${opts.seconds}s` : ""}… (SIGINT/SIGTERM to stop)`);
  await record(
    () =>
      new Promise((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
        if (opts.seconds) setTimeout(done, Number(opts.seconds) * 1000);
      }),
  );
} else {
  rl.removeAllListeners("close");
  rl.close();
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  const key = () =>
    new Promise((r) =>
      process.stdin.once("keypress", (str, k = {}) => {
        if (k.ctrl && k.name === "c") process.exit(0);
        r(k.name ?? str);
      }),
    );
  const isEnter = (k) => k === "return" || k === "enter" || k === "space";
  for (;;) {
    const flags = Object.entries(TOGGLES)
      .map(([k, [name, label]]) => `[${k}] ${label} ${opts[name] ? "\x1b[32m●\x1b[0m" : "○"}`)
      .join("  ");
    process.stdout.write(`\r\x1b[2K${flags}   ⏎ record  q quit`);
    const k = await key();
    if (k === "q") process.exit(0);
    if (TOGGLES[k]) {
      const [name, , on = true] = TOGGLES[k];
      opts[name] = opts[name] ? undefined : on;
    }
    if (!isEnter(k)) continue;
    console.log("\n\x1b[31m●\x1b[0m Recording… ⏎ to stop");
    await record(async () => {
      while (!isEnter(await key()));
    });
  }
}
process.exit(0);
