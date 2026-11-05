#!/usr/bin/env node
// Record Chrome DevTools Performance traces over CDP, streamed to disk. See README.md.
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

Chrome for Testing: cd ~/.cache/puppeteer && npx -y @puppeteer/browsers install chrome@canary`;
import { spawn } from 'node:child_process';
import { createWriteStream, globSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';

const CHROME = process.env.CHROME ?? globSync([
  '.cache/puppeteer/chrome/*/*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
].map(p => join(homedir(), p))).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const PORT = process.env.PORT ?? 9222;
const PROFILE = process.env.PROFILE ?? join(homedir(), '.cdp-trace-chrome');
const OUT = process.cwd();
const BASE = `http://127.0.0.1:${PORT}`;

// DevTools Performance panel defaults + JS sampling + screenshots
// (devtools-frontend front_end/models/trace/types/TraceEvents.ts DefaultCategories).
// Custom tracks: performance.mark/measure → blink.user_timing, console.timeStamp → devtools.timeline.
const CATEGORIES = [
  '-*', 'blink.console', 'blink.user_timing', 'loading', 'devtools.timeline',
  'disabled-by-default-devtools.target-rundown', 'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.v8-source-rundown-sources', 'disabled-by-default-devtools.v8-source-rundown',
  'disabled-by-default-layout_shift.debug', 'disabled-by-default-v8.inspector',
  'disabled-by-default-v8.cpu_profiler.hires', 'disabled-by-default-lighthouse',
  'v8.execute', 'v8', 'cppgc', 'navigation', 'rail',
  'disabled-by-default-v8.cpu_profiler', 'disabled-by-default-devtools.screenshot',
];
const SELECTOR_STATS = ['disabled-by-default-blink.debug', 'disabled-by-default-devtools.timeline.invalidationTracking'];

// Known flags are removed from args; whatever is left goes to Chrome.
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}
const flag = name => args.includes(name) && !!args.splice(args.indexOf(name), 1);
const value = name => {
  if (!args.includes(name)) return undefined;
  const [, v] = args.splice(args.indexOf(name), 2);
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} needs a value. See --help.`);
    process.exit(1);
  }
  return v;
};
const TAB = value('--tab');
const SECONDS = value('--seconds');
const SELECTOR_STATS_ON = flag('--selector-stats');
const SOURCE_MAPS_ON = flag('--source-maps');
const NAVIGATE_URL = value('--url');
const INIT_SCRIPT = value('--init-script');
const LEAN = flag('--lean');
// Script sources + screenshots are most of the trace size; metrics and CPU profile don't need them.
const LEAN_DROP = ['disabled-by-default-devtools.v8-source-rundown-sources', 'disabled-by-default-devtools.screenshot'];
const THROTTLE = value('--throttle');
const SCENARIO = value('--scenario');
const OUT_FILE = value('--out');
const AUTO = [TAB, SECONDS, NAVIGATE_URL, SCENARIO].some(v => v !== undefined);

const isUp = () => fetch(`${BASE}/json/version`).then(r => r.ok, () => false);
if (await isUp()) {
  console.log(`Attached to Chrome already running on port ${PORT} (left running on exit)`);
} else {
  if (!CHROME) throw new Error('Chrome for Testing not found. Install: cd ~/.cache/puppeteer && npx -y @puppeteer/browsers install chrome@canary');
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', ...args,
  ], { stdio: 'ignore' });
  chrome.on('exit', code => { console.log(`\nChrome exited (${code})`); process.exit(0); });
  process.on('exit', () => chrome.kill());
  for (let i = 0; !(await isUp()); i++) {
    if (i === 50) console.log(`Still waiting for debugging port ${PORT} (port in use, or RemoteDebuggingAllowed policy — check chrome://policy). Chrome stays open; Ctrl+C to quit.`);
    await new Promise(r => setTimeout(r, 200));
  }
}

const rl = AUTO ? undefined : createInterface({ input: process.stdin, output: process.stdout });
rl?.on('SIGINT', () => process.exit(0));
rl?.on('close', () => process.exit(0));

await rl?.question('Chrome is up. Open your page, then press Enter… ');
const pages = (await (await fetch(`${BASE}/json/list`)).json())
  .filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!pages.length) throw new Error('No open tabs');
let page = pages[0];
if (TAB) {
  page = pages.find(p => `${p.url} ${p.title}`.toLowerCase().includes(TAB.toLowerCase()));
  if (!page) {
    console.error(`No tab matches "${TAB}". Open tabs:\n${pages.map(p => `  ${p.title} — ${p.url}`).join('\n')}`);
    process.exit(1);
  }
} else if (!AUTO && pages.length > 1) {
  pages.forEach((p, i) => console.log(`  [${i + 1}] ${p.title} — ${p.url}`));
  page = pages[Number(await rl.question('Tab number: ')) - 1] ?? pages[0];
}
console.log(`Using: ${page.title} — ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.onclose = () => {
  console.error('\nDevTools connection closed (tab closed, or RemoteDebuggingAllowed policy kicked in).');
  process.exit(1);
};
let nextId = 0;
const pending = new Map();
const waiters = new Map();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else waiters.get(msg.method)?.(msg.params);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++nextId, { resolve, reject });
  ws.send(JSON.stringify({ id: nextId, method, params }));
});
const waitFor = method => new Promise(resolve => waiters.set(method, resolve));

if (INIT_SCRIPT) await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });
if (NAVIGATE_URL) {
  await send('Page.enable');
  const loaded = waitFor('Page.loadEventFired');
  await send('Page.navigate', { url: NAVIGATE_URL });
  await loaded;
  waiters.delete('Page.loadEventFired');
}

async function readStream(handle, onChunk) {
  for (;;) {
    const { data, base64Encoded, eof } = await send('IO.read', { handle, size: 1 << 20 });
    await onChunk(Buffer.from(data, base64Encoded ? 'base64' : 'utf8'));
    if (eof) break;
  }
  await send('IO.close', { handle });
}

async function write(out, chunk) {
  if (!out.write(chunk)) await once(out, 'drain');
}

// Map URL -> script URL, resolved the way DevTools matches them when loading a trace.
// Debugger is enabled only after recording, so it adds no overhead to the trace.
async function listSourceMaps() {
  const maps = new Map();
  waiters.set('Debugger.scriptParsed', ({ url, sourceMapURL }) => {
    if (!url || !sourceMapURL || sourceMapURL.startsWith('data:') || url.startsWith('chrome-extension:')) return;
    try { maps.set(new URL(sourceMapURL, url).href, url); } catch {}
  });
  await send('Debugger.enable');
  await send('Debugger.disable');
  waiters.delete('Debugger.scriptParsed');
  return maps;
}

// Fetched through the browser so cookies/auth apply, same as DevTools does.
async function writeSourceMaps(out, maps) {
  const { frameTree } = await send('Page.getFrameTree');
  let written = 0, i = 0;
  for (const [sourceMapUrl, url] of maps) {
    process.stdout.write(`\rSource maps ${++i}/${maps.size}…`);
    try {
      const { resource } = await send('Network.loadNetworkResource', {
        frameId: frameTree.frame.id, url: sourceMapUrl, options: { disableCache: false, includeCredentials: true },
      });
      if (!resource.success || resource.httpStatusCode >= 400) throw new Error(resource.netErrorName ?? `HTTP ${resource.httpStatusCode}`);
      const parts = [];
      await readStream(resource.stream, chunk => parts.push(chunk));
      const map = JSON.parse(Buffer.concat(parts).toString().replace(/^\)\]\}'.*\n/, ''));
      // sourcesContent is ~80% of map size and only needed to view original source; names/locations work without it.
      delete map.sourcesContent;
      await write(out, `${written++ ? ',' : ''}{"url":${JSON.stringify(url)},"sourceMapUrl":${JSON.stringify(sourceMapUrl)},"sourceMap":${JSON.stringify(map)}}`);
    } catch (e) {
      console.warn(`\nSkipped ${sourceMapUrl}: ${e.message}`);
    }
  }
  console.log(`\rEmbedded ${written}/${maps.size} source maps`);
}

async function save(handle, file, maps) {
  const out = createWriteStream(file);
  let bytes = 0;
  // The last two chunks are held back so source maps can be spliced in before the closing braces.
  let prev = Buffer.alloc(0), last = Buffer.alloc(0);
  await readStream(handle, async chunk => {
    await write(out, prev);
    [prev, last] = [last, chunk];
    bytes += chunk.length;
    process.stdout.write(`\rSaving… ${(bytes / 1e6).toFixed(1)} MB`);
  });
  const tail = Buffer.concat([prev, last]);
  let end = tail.length;
  while (end && tail[end - 1] <= 0x20) end--;
  const closing = tail.subarray(end - 2, end).toString();
  if (maps && closing === '}}') {
    // Chrome writes {"traceEvents":[...],"metadata":{...}}, so the sourceMaps go into metadata.
    await write(out, tail.subarray(0, end - 2));
    await write(out, tail[end - 3] === 0x7b ? '"sourceMaps":[' : ',"sourceMaps":[');
    await writeSourceMaps(out, maps);
    await write(out, ']}}');
  } else if (maps && closing === ']}') {
    await write(out, tail.subarray(0, end - 1));
    await write(out, ',"metadata":{"sourceMaps":[');
    await writeSourceMaps(out, maps);
    await write(out, ']}}');
  } else {
    if (maps) console.warn(`\nUnexpected trace ending "${closing}", source maps not embedded`);
    await write(out, tail);
  }
  out.end();
  await once(out, 'finish');
  console.log(`\rSaved ${file} (${(out.bytesWritten / 1e6).toFixed(1)} MB)`);
  // DevTools reads the file into one string; V8 caps strings at ~536M chars.
  if (out.bytesWritten > 536e6) console.warn('Warning: file is over ~536 MB, DevTools will fail to load it. Record a shorter window.');
}

async function record(stopped) {
  await send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    // Default 200 MB buffer fills in ~30s on a large web app (script sources alone can be ~150 MB), then drops events.
    traceConfig: { includedCategories: [...(LEAN ? CATEGORIES.filter(c => !LEAN_DROP.includes(c)) : CATEGORIES), ...(opts.s.on ? SELECTOR_STATS : [])], traceBufferSizeInKb: 2_000_000 },
  });
  if (THROTTLE) await send('Emulation.setCPUThrottlingRate', { rate: Number(THROTTLE) });
  try {
    await stopped();
  } finally {
    if (THROTTLE) await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  const done = waitFor('Tracing.tracingComplete');
  await send('Tracing.end');
  const { stream, dataLossOccurred } = await done;
  if (dataLossOccurred) console.warn('Warning: trace buffer filled up, some events were dropped');
  const maps = opts.m.on ? await listSourceMaps() : undefined;
  await save(stream, OUT_FILE ?? join(OUT, `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), maps);
}

mkdirSync(OUT_FILE ? dirname(OUT_FILE) : OUT, { recursive: true });
const opts = {
  s: { label: 'CSS selector stats', on: SELECTOR_STATS_ON },
  m: { label: 'Embed source maps', on: SOURCE_MAPS_ON },
};

if (SCENARIO) {
  const { default: scenario } = await import(resolvePath(SCENARIO));
  console.log(`Recording scenario ${SCENARIO}…`);
  await record(() => scenario({ send, waitFor }));
  process.exit(0);
}

if (AUTO) {
  console.log(`Recording${SECONDS ? ` for ${SECONDS}s` : ''}… (SIGINT/SIGTERM to stop)`);
  await record(() => new Promise(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    if (SECONDS) setTimeout(resolve, Number(SECONDS) * 1000);
  }));
  process.exit(0);
}

for (;;) {
  for (const [key, o] of Object.entries(opts)) console.log(`[${key}] ${o.label}: ${o.on ? 'ON' : 'off'}`);
  const key = (await rl.question('Enter to START, letter+Enter to toggle (Ctrl+C to quit)… ')).trim().toLowerCase();
  if (opts[key]) { opts[key].on = !opts[key].on; continue; }
  await record(() => rl.question('Recording. Enter to STOP… '));
}
