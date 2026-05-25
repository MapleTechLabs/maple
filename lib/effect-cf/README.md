# @maple/effect-cf

Vendored copy of [**effect-cf**](https://github.com/danieljvdm/effect-cf) by Dan van der Merwe —
Effect-native primitives for Cloudflare Workers, Durable Objects, bindings, KV, R2, Queues, and
Workflows. MIT licensed; see [`LICENSE`](./LICENSE).

This is inlined as a private workspace package (`@maple/effect-cf`) rather than tracked as an npm
dependency. The `src/` is a faithful mirror of upstream so it can be re-synced.

- **Upstream:** https://github.com/danieljvdm/effect-cf (package `packages/effect-cf`)
- **Vendored at commit:** `9400f05f55abb12c6bcd4cf4f576d215a622bb8a`

## Local divergences from upstream

Keep this list current so re-syncs stay tractable. Apply changes additively and minimally.

- **`src/cloudflare-env.d.ts`** (maple-added): ambient `declare namespace Cloudflare { interface Env {} }`
  so the vendored source typechecks standalone in this package. Each consuming worker's generated
  `worker-configuration.d.ts` merges with it.
- **`src/Worker.ts`** (maple-extended): added a `scheduled` handler to `WorkerOptions` /
  `WorkerClass` and a `scheduled(controller)` method on the generated entrypoint, so cron workers
  can run through `Worker.make`. Upstream only ships `fetch` / `queue` / `rpc`.

## Notes

- Maple uses `Binding.Service` for D1 (raw binding → drizzle), not `D1.Service.sqlLayer`, so
  `@effect/sql-d1` / `@effect/sql-pg` are present only so the vendored `D1.ts` / `HyperdrivePg.ts`
  typecheck; they should tree-shake out of the worker bundles.
