---
"@maple-dev/effect-sdk": minor
---

The Cloudflare preset and `MapleFlush.make` export without an ingest key when the endpoint is not Maple's hosted ingest, as `Maple.layer` already does. A Worker or flushable pointed at a local `maple start` or a self-hosted collector no longer needs a placeholder key. Keyless against the hosted ingest, including with nothing configured, still runs in no-op mode, and its notice now also suggests pointing `MAPLE_ENDPOINT` at your own collector.
