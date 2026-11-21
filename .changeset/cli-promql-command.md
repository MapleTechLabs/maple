---
"@maple/cli": minor
---

`maple promql '<query>'` runs PromQL over your metrics from the terminal, against the local store or a hosted workspace. `--since` / `--start` / `--end` pick the window, `--step` the resolution and `--instant` evaluates once at its end. `--format table` prints each series with its last value, min, average, max and a sparkline; a syntax error points at its position. `maple promql metrics [filter]` lists the Prometheus metric names a query can select.
