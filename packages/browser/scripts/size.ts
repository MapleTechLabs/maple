#!/usr/bin/env bun
/**
 * Measure what installing `@maple-dev/browser` actually costs a page.
 *
 * The number that matters is not the size of our `dist/` — that ships
 * unminified and with every dependency left external, so reading it tells you
 * almost nothing. What a visitor downloads is the *bundled, minified, gzipped*
 * graph their bundler produces, OpenTelemetry and rrweb included. This builds
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
	 * 43.5 since 2026-09: the offline queue's exporter wrapper (~0.2 kB). 43: XHR spans and the HTTP status policy, which must patch
	 * before the app's first request (~1.5 kB). Document timing went to the
	 * deferred chunk instead. 42: error filters and cause chains. 41 before that:
	 * per-session trace sampling and the `logger` queue added ~2.4 kB (~1.2 kB
	 * code, the rest chunk-split overhead now that a second chunk shares the OTel
	 * core). Was 38 for navigation spans.
	 */
	eager: 43.5,
	/**
	 * Every page load, after `init()`: the OTel logs SDK and exporter, document
	 * timing, and `web-vitals` (~3.3 kB, 8 -> 12).
	 */
	deferred: 12,
	lazy: 68,
	/**
	 * Our own eager code, with OpenTelemetry and rrweb left external.
	 *
	 * Tracked separately because the headline `eager` number is dominated by
	 * OTel, which many host apps already ship — for them the marginal cost of
	 * this SDK is this line, not that one. It is also the only figure a change
	 * to our source can move — the other two are ~90% third-party and would
	 * absorb a doubling of our code without crossing a ceiling — so this is the
	 * one that makes a regression legible. Kept deliberately tight.
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
	 * offline queue's exporter wrapper.
	 */
	firstParty: 18,
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
	const entryChunk = group.find((chunk) => chunk.name.startsWith("index.")) ?? group[0]!
	const names = new Set<string>([entryChunk.name])
	const queue = [entryChunk]
	while (queue.length > 0) {
		const chunk = queue.pop()!
		for (const match of chunk.text.matchAll(/(?:from|import)\s*"\.\/([^"]+)"/g)) {
			const name = match[1]!
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

// Same entry, dependencies left external: what a host app that already ships
// OpenTelemetry pays to add this SDK. The lazy chunk is rrweb-dominated and
// disappears entirely here, so only the eager side is meaningful.
// Walked, not filtered to `index.*`: code splitting can park first-party code
// in a shared chunk the entry statically imports, which is exactly as eager as
// the entry itself. Filtering by name silently excluded it — that is how ~30 kB
// of bundled `effect/Schema` sat inside budget while this line reported 3.5 kB.
const firstParty = eagerChunks(await measure((await build(["@opentelemetry/*", "rrweb"])).outputs))

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
