#!/usr/bin/env bun
/**
 * Measure what installing `@maple-dev/browser` actually costs a page.
 *
 * The number that matters is not the size of our `dist/` — that ships
 * unminified and with every dependency left external, so reading it tells you
 * almost nothing. What a visitor downloads is the *bundled, minified, gzipped*
 * graph their bundler produces, the OpenTelemetry API and rrweb included. This builds
 * exactly that and splits it three ways:
 *
 *   eager    — the entry plus everything statically reachable from it. Paid by
 *              every visitor on every page load, before any sampling decision.
 *   deferred — the `./deferred` chunk `init()` imports right away. Paid by every
 *              visitor too, but after `init()` and off the critical path.
 *   lazy     — the rrweb chunk. Paid only by visitors sampled into replay,
 *              which is the entire point of the code split.
 *
 * A regression in `eager` is the expensive kind: it hits 100% of page loads.
 * The budgets below fail CI so that cost has to be argued for in review rather
 * than discovered in a customer's Lighthouse report.
 */
import { gzipSync } from "node:zlib"

/** Ceilings in gzipped KB. Raise deliberately, with the reason in the commit. */
const BUDGET = {
	/**
	 * 38.5 since 2026-11: the OpenTelemetry JS SDK, instrumentations and OTLP
	 * transformer were replaced by in-house code (only `@opentelemetry/api` is left),
	 * and eager fell 46.12 → 37.25 kB.
	 *
	 * 47 since 2026-10: main already measured 45.26 kB; the SDK hardening pass
	 * (surrogate-safe text, UUID fallback, consent purge, wider URL redaction,
	 * status-aware retries, the consent settle window) added ~1.25 kB before any sampling.
	 * 44.5 since 2026-09: `@maple/sdk-core`'s page-wide coordination with the Effect
	 * SDK (one error is one issue across SDK copies) and shared option resolution (~0.4 kB).
	 * 44: `tracing.captureHeaders` in the request hooks (~0.3 kB).
	 * 43.5: the offline queue's exporter wrapper (~0.2 kB). 43: XHR spans and the HTTP status policy, which must patch
	 * before the app's first request (~1.5 kB). Document timing went to the
	 * deferred chunk instead. 42: error filters and cause chains. 41 before that:
	 * per-session trace sampling and the `logger` queue added ~2.4 kB (~1.2 kB
	 * code, the rest chunk-split overhead now that a second chunk shares the OTel
	 * core). Was 38 for navigation spans.
	 */
	eager: 38.5,
	/**
	 * Every page load, after `init()`, off the critical path: the logs pipeline,
	 * document timing, `web-vitals` (~3.3 kB), breadcrumbs,
	 * reports, the offline queue and long-frame/interaction spans. 14.5 since
	 * 2026-10: main measured 14.04 kB; the logs pagehide flush adds ~0.1 kB.
	 * 10.5 since 2026-11: the in-house logs pipeline replaced the OTel logs SDK
	 * (13.74 → 9.64 kB).
	 */
	deferred: 10.5,
	lazy: 68,
	/**
	 * Our own eager code, with `@opentelemetry/api` and rrweb left external.
	 *
	 * Tracked separately because it is the figure a change to our source moves
	 * most legibly: the API is what a host app that already uses OpenTelemetry
	 * shares with us, so for it the marginal cost of this SDK is this line.
	 * Kept deliberately tight.
	 *
	 * 35 since 2026-11: the span, log, propagation, request instrumentation and
	 * OTLP/JSON code that came from OpenTelemetry JS packages is first-party now,
	 * so it moved into this line (26.07 → 34.36 kB) while `eager` fell by 8.9 kB.
	 *
	 * 11, not the 5 this once read: that 5 was calibrated against a measurement
	 * that counted only the entry chunk and silently dropped the shared chunk
	 * next to it. Our eager first-party code has been ~10 kB the whole time.
	 *
	 * 13.5 since 2026-09: default URL redaction, the duplicated-tab lease, the
	 * shared keepalive budget, per-session replay sampling and the `region`
	 * option added ~1.9 kB, all on paths that must run before the lazy chunk.
	 *
	 * 14.5 since 2026-09: navigation and data-loading spans (`startNavigation`,
	 * `endNavigation`, `traced`) added ~0.6 kB. Apps used to copy the same code
	 * into their own bundle, so for them this is a move rather than a cost.
	 *
	 * 16 since 2026-09: the session sampler (~0.7 kB) and the `logger` queue
	 * (~0.5 kB), both needed before the deferred chunk lands. 17 for error
	 * filters and cause chains (~0.8 kB), which run on the capture path. 17.5
	 * for `errors.captureHttpStatus`, applied by the span exporter. 18 for the
	 * offline queue's exporter wrapper, 18.5 for `tracing.captureHeaders`. 19 for
	 * `@maple/sdk-core`'s page-wide coordination with the Effect SDK (~0.45 kB).
	 * 19.5 for the linear stack-frame parser that replaced a backtracking regex (CodeQL).
	 * 25 since 2026-10: main already measured 23.43 kB; the hardening pass above adds ~1 kB.
	 * 20: the OTLP exporter moved from an external dependency into first-party code; eager fell 43.67 → 41.28 kB.
	 * 25.5 since 2026-11: CORS-safe trace propagation (strip the sampling `ot` member on
	 * cross-origin requests only), prefix CORS URLs and the no-response status cleanup (~0.2 kB).
	 * 26: requests a reload cancels are not errors (spans and their rejections), and
	 * `errors.ignoreNetworkFailuresFor`, sampled-out sessions included (~0.55 kB).
	 * 26.5 since 2026-11: `persistence: "cookieless"` (the row visitor rule, memory-wins
	 * guard against older copies) measured 26.07 kB.
	 * 35.5 since 2026-11: main measured 34.97 kB; `maple.exception.debug_ids` (source map debug
	 * ids on every exception event, on the capture path) adds ~0.2 kB.
	 */
	firstParty: 35.5,
}

/** How close to a ceiling counts as worth warning about. */
const WARN_AT = 0.9

const KB = 1024
const kb = (bytes: number): number => bytes / KB
const fmt = (bytes: number): string => `${kb(bytes).toFixed(2)} kB`

const build = async (external: string[] = []) => {
	const result = await Bun.build({
		entrypoints: ["./src/index.ts"],
		target: "browser",
		format: "esm",
		minify: true,
		splitting: true,
		external,
		throw: false,
	})
	if (!result.success) {
		console.error("build failed:")
		for (const log of result.logs) console.error(log)
		process.exit(1)
	}
	return result
}

const result = await build()

interface Chunk {
	readonly name: string
	readonly raw: number
	readonly gzip: number
	readonly text: string
}

const measure = async (outputs: Array<{ path: string; text: () => Promise<string> }>): Promise<Chunk[]> =>
	Promise.all(
		outputs.map(async (output) => {
			const text = await output.text()
			const raw = Buffer.byteLength(text)
			return { name: output.path.replace(/^.*\//, ""), raw, gzip: gzipSync(text).length, text }
		}),
	)

const chunks = await measure(result.outputs)

/**
 * Walk static imports from the entry. Anything reached this way lands in the
 * eager graph; everything else is behind an `import()` and only downloads when
 * that import runs.
 */
const eagerChunks = (group: Chunk[]): Chunk[] => {
	const entryChunk = group.find((chunk) => chunk.name.startsWith("index.")) ?? group[0]
	const names = new Set<string>([entryChunk.name])
	const queue = [entryChunk]
	while (queue.length > 0) {
		const chunk = queue.pop()!
		for (const match of chunk.text.matchAll(/(?:from|import)\s*"\.\/([^"]+)"/g)) {
			const name = match[1]
			if (names.has(name)) continue
			const next = group.find((candidate) => candidate.name === name)
			if (!next) continue
			names.add(name)
			queue.push(next)
		}
	}
	return group.filter((chunk) => names.has(chunk.name))
}

const eager = eagerChunks(chunks)
const eagerNames = new Set(eager.map((chunk) => chunk.name))
const notEager = chunks.filter((chunk) => !eagerNames.has(chunk.name))
// The rrweb chunk is the one carrying the recorder; every other `import()`
// target is deferred work that every page load fetches.
const isReplay = (chunk: Chunk): boolean => chunk.text.includes("rrweb")
const lazy = notEager.filter(isReplay)
const deferred = notEager.filter((chunk) => !isReplay(chunk))
const total = (group: Chunk[]): number => group.reduce((sum, chunk) => sum + chunk.gzip, 0)

// Same entry, the API and rrweb left external: what a host app that already ships
// `@opentelemetry/api` pays to add this SDK. The lazy chunk is rrweb-dominated and
// disappears entirely here, so only the eager side is meaningful.
// Walked, not filtered to `index.*`: code splitting can park first-party code
// in a shared chunk the entry statically imports, which is exactly as eager as
// the entry itself. Filtering by name silently excluded it — that is how ~30 kB
// of bundled `effect/Schema` sat inside budget while this line reported 3.5 kB.
const firstParty = eagerChunks(await measure((await build(["@opentelemetry/api", "rrweb"])).outputs))

const report = (label: string, group: Chunk[], budget: number): boolean => {
	const gzip = total(group)
	const ratio = kb(gzip) / budget
	const state = ratio > 1 ? "OVER" : ratio > WARN_AT ? "near" : "ok"
	console.log(`\n${label}  ${fmt(gzip)} gzipped  (budget ${budget} kB — ${state})`)
	for (const chunk of [...group].sort((a, b) => b.gzip - a.gzip)) {
		console.log(
			`    ${chunk.name.padEnd(32)} ${fmt(chunk.raw).padStart(11)} → ${fmt(chunk.gzip)} gzipped`,
		)
	}
	return ratio <= 1
}

console.log("@maple-dev/browser — bundled, minified, gzipped")
const eagerOk = report("eager     every page load ", eager, BUDGET.eager)
const deferredOk = report("deferred  every page load, after init", deferred, BUDGET.deferred)
const lazyOk = report("lazy      sampled sessions", lazy, BUDGET.lazy)
const firstPartyOk = report("ours      eager, deps external", firstParty, BUDGET.firstParty)

if (!eagerOk || !deferredOk || !lazyOk || !firstPartyOk) {
	console.error("\nbundle size exceeds budget — raise it in scripts/size.ts if the cost is intended")
	process.exit(1)
}
