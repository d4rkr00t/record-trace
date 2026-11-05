---
name: record-trace
description: Record a Chrome DevTools Performance trace with the `record-trace` CLI. Use when the user wants to profile a page, capture a performance trace, or measure an interaction or page load, whether the user drives the page by hand or the agent scripts it.
---

# record-trace

Records a trace with the DevTools Performance panel categories to `./trace-<timestamp>.json`. Flags: `record-trace --help`.

## Setup

- Needs Chrome for Testing: `mkdir -p ~/.cache/puppeteer && cd ~/.cache/puppeteer && npx -y @puppeteer/browsers install chrome@canary`.
- Agent sandboxes often block Chrome. If launching fails with a permissions error, rerun outside the sandbox.

## Modes

| Situation                      | Command                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| User drives, says when to stop | run `record-trace --tab <text>` in the background, then send SIGINT to stop                |
| Page load                      | `record-trace --url <url> --seconds 5`                                                     |
| Agent drives                   | `record-trace --url <url> --scenario ./scenario.mjs`                                       |
| No display                     | add `--headless --window-size=1440,900` (the default 800x600 viewport changes layout cost) |

## Scenarios

The recording stops when the scenario resolves.

```js
export default async ({ send, waitFor }) => {
  await send("Runtime.evaluate", { expression: `document.querySelector("textarea").focus()` });
  for (const text of "hello") {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text });
    await send("Input.dispatchKeyEvent", { type: "keyUp" });
  }
  await new Promise((r) => setTimeout(r, 1000));
};
```

- `send(method, params)` sends a CDP command. `waitFor(event)` resolves with the next event of that name.
- Use `Input.dispatch*` events. `el.click()` inside `Runtime.evaluate` doesn't count as an interaction, so it doesn't show up in INP or EventTiming.
- Wait about 1s after the last input, or the final interactions are missing from the trace.

## Output

- Traces only scripts will read: add `--lean`, which makes them about 15× smaller with metrics unchanged.
- Traces a human will open in DevTools: leave out `--lean` and add `--source-maps`.
