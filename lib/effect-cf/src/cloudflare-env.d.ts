// Ambient fallback so the vendored effect-cf source typechecks standalone.
//
// effect-cf's `Environment.ts` references the global `Cloudflare.Env` type,
// which is normally produced per-worker by `wrangler types`
// (`worker-configuration.d.ts`). The library itself ships no such global, so
// in this package's isolated `tsc --noEmit` it would be unresolved. This empty
// interface merges with each consuming worker's generated `Cloudflare.Env`
// (declaration merging) and provides a safe `{}` shape here.
declare namespace Cloudflare {
	interface Env {}
}
