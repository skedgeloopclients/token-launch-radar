# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/skedgeloopclients/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/skedgeloopclients/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar prices every pre-token protocol in the sealed DefiLlama snapshot from category comparables learned from the same snapshot, ranks them by implied value, and renders a static offline dashboard with a detail view and concrete farm plans. Already-listed protocols are shown separately with the market's own value.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
```

The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into `out/`. It uses the Node 22 standard library only and needs no network.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8wr36c10&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
