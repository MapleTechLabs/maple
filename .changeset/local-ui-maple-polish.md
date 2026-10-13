---
"@maple/cli": patch
---

The local dashboard looks like Maple again. It bundles the Geist fonts, uses the shared design tokens (amber in light mode, colored JSON highlighting), and no longer flashes dark on a light-mode OS. Service colors now show in the traces list, logs, metrics, span and session panels and every service filter, and severity colors show in the logs filter. Logs strip ANSI color codes, show `+N lines` for multi-line bodies, and only rail errors and warnings. New 5m, 15m, 30m and 12h time ranges. Fixes: the service map panel now matches its node when a service reports several environments, abandoned browser sessions no longer show as active forever, "Throughput by operation" is a per-second rate, and a failed metric preview says so.
