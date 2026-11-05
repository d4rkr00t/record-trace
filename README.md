# record-trace

Record Chrome DevTools Performance traces from the command line. You interact with the page yourself (or script it), and get a trace you can load into the DevTools Performance panel.

- Uses the same trace categories as the DevTools Performance panel, plus JS sampling and screenshots.
- Streams the trace to disk in chunks, so long recordings don't run out of memory.
- Can embed source maps into the trace metadata, so DevTools shows original function names.
- No dependencies. Needs Node 22+.

## Setup

Install Chrome for Testing once:

```sh
mkdir -p ~/.cache/puppeteer && cd ~/.cache/puppeteer && npx -y @puppeteer/browsers install chrome@canary
```

## Usage

```sh
npx record-trace https://example.com
```

Chrome opens. Get the page ready, press Enter, pick a tab, press Enter to start, interact with the page, then press Enter to stop. The trace is saved to `./trace-<timestamp>.json`. Load it into DevTools from Performance → Load profile.

Non-interactive (from scripts or agents):

```sh
npx record-trace --tab example --seconds 10 --source-maps
npx record-trace --url https://example.com --throttle 4 --out load.json   # page-load trace
npx record-trace --headless --scenario ./type-text.mjs --lean           # scripted interaction
```

| Option               |                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--tab <text>`       | Record the tab whose URL or title contains `text` (default: the first tab)                                 |
| `--seconds <n>`      | Stop after `n` seconds (otherwise stop on SIGINT/SIGTERM)                                                  |
| `--url <url>`        | Navigate the tab and wait for load before recording                                                        |
| `--scenario <file>`  | Run a CDP script while recording; recording stops when it resolves (see below)                             |
| `--init-script <js>` | Run in every frame before page scripts (`Page.addScriptToEvaluateOnNewDocument`)                           |
| `--throttle <n>`     | Throttle the CPU by `n`× while recording                                                                   |
| `--source-maps`      | Embed source maps into the trace metadata (fetched with the page's cookies)                                |
| `--selector-stats`   | Include CSS selector stats                                                                                 |
| `--lean`             | Skip script sources and screenshots, for a much smaller trace. Metrics and the CPU profile are unaffected. |
| `--out <file>`       | Output path                                                                                                |
| anything else        | Passed to Chrome, e.g. `--headless`                                                                        |

| Env       | Default                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `CHROME`  | Newest Chrome for Testing in `~/.cache/puppeteer`                         |
| `PORT`    | `9222`                                                                    |
| `PROFILE` | `~/.cdp-trace-chrome` (the user data dir, so logins persist between runs) |

In interactive mode, press `s`, `m` or `t` to toggle selector stats, source maps or 4x CPU throttling; Enter starts/stops recording, `q` quits.

### Scenarios

A scenario is a module that drives the page over the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) while the trace is recording:

```js
// type-text.mjs
export default async ({ send, waitFor }) => {
  await send("Runtime.evaluate", { expression: 'document.querySelector("textarea").focus()' });
  for (const ch of "hello") {
    await send("Input.dispatchKeyEvent", { type: "char", text: ch });
  }
  await new Promise((r) => setTimeout(r, 1000));
};
```

`send(method, params)` sends a CDP command to the tab. `waitFor(eventName)` resolves with the params of the next event with that name.

### Sharing the browser

If Chrome is already listening on `PORT`, record-trace attaches to it and leaves it running when it exits. That means you can use it alongside [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) with `--browserUrl http://127.0.0.1:9222`.

## Agent skill

The package includes a skill that teaches coding agents to record traces with `record-trace`.

Claude Code:

```
/plugin install record-trace --marketplace d4rkr00t/record-trace
```

Other agents: link the skill from the installed package into the agent's skills directory, so it stays in sync with the CLI version:

```sh
ln -s "$(npm root -g)/record-trace/skills/record-trace" ~/.agents/skills/record-trace
```

## Limits

- DevTools reads the whole trace file into a single string, which V8 caps at about 536 MB, so larger files won't load. record-trace warns when this happens. Record a shorter window, or use `--lean`.
- Chrome's trace buffer is set to 2 GB. If it fills up, Chrome drops events and record-trace prints a warning.
