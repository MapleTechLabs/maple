---
"@maple/cli": minor
---

`maple start` can require credentials when it is reachable beyond loopback. Set `MAPLE_LOCAL_INGEST_KEY` to require a key on OTLP ingest (`Authorization: Bearer` or `x-maple-ingest-key`), and `MAPLE_LOCAL_ACCESS_TOKEN` to require sign-in for the dashboard and query API. The bundled dashboard shows a sign-in page, scripts send the token as a Bearer token, and CLI commands send it when the variable is set. Without them, a non-loopback start still runs and the banner warns that it is open.
