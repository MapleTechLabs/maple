---
"@maple/cli": minor
---

Maple Local ships as a container image, `ghcr.io/mapletechlabs/maple`, for running it on a server or a container platform. It requires `MAPLE_LOCAL_INGEST_KEY` and `MAPLE_LOCAL_ACCESS_TOKEN`, keeps everything on a `/data` volume, runs unprivileged, listens on `$PORT` when the platform sets one, and recovers from an unclean stop on its own. See the Self-hosting docs.
