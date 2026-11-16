# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

[![rank](https://make.fun/badge/markdown-render-speed-02/aramexbit/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

[![reward](https://make.fun/badge/markdown-render-speed-02/aramexbit/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, fast Markdown renderer. `parse(markdown)` returns exactly the HTML that marked 18.1.3 returns with its default options (GFM on, breaks off, pedantic off), for every input — CommonMark 0.31.2 plus the GFM 0.29 extensions (tables, task lists, strikethrough, extended autolinks, disallowed raw HTML) — at a fraction of marked's CPU time.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json`, renders each with `parse`, and writes `/output/html.json`.

## Layout

- `parse.js` — the renderer (ES module, no dependencies)
- `main.ts` — the driver the harness runs

---

<sub>Entered on [make.fun](https://make.fun/?ref=rrcbfccn&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
