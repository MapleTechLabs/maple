---
"@maple-dev/alchemy": minor
---

`alchemy dev` can run Maple Local for the stack. Declare `Local("observability")` from `@maple-dev/alchemy/local`, register `localProviders()`, and pass it as `Telemetry({ local })`: under `alchemy dev` every Worker exports to one shared loopback server, with no ingest key and no Maple account, and the dashboard opens at `local.maple.dev`. Deploys ignore `local` and use `ingestKey` and `endpoint` as before.

The server runs in an Alchemy sidecar process, survives stack reloads, and stores data per stack, stage and resource under `.alchemy/maple-local/`. The first run downloads the pinned chDB library, verifies its sha256 and caches it in `~/.maple/cache/libchdb`; `MAPLE_LIBCHDB` points at a copy you already have. Another project on `4318` moves the listener to a free port, and a second `alchemy dev` of the same stack shares the running server. `LocalProps` takes `dataDir`, `port` (binds exactly that port) and `onDirtyStore`: a store left unclean by a killed sidecar is refused unless it is `"wipe"`.

Requires Bun, and `@effect/platform-bun` as an optional peer dependency (Alchemy already needs it under Bun).
