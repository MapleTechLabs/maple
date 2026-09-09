// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { join } from "node:path"

interface ManifestChunk {
	file: string
	imports?: string[]
}

const DIST = join(import.meta.dirname, "..", "dist")
const manifest = JSON.parse(readFileSync(join(DIST, ".vite", "manifest.json"), "utf8")) as Record<
	string,
	ManifestChunk
>

const entryKey = "index.html"
if (!manifest[entryKey])
	throw new Error("Vite manifest has no index.html entry; run the production build first")

const staticGraph = new Set<string>()
const visit = (key: string) => {
	if (staticGraph.has(key)) return
	const chunk = manifest[key]
	if (!chunk) throw new Error(`Manifest import ${key} is missing`)
	staticGraph.add(key)
	for (const imported of chunk.imports ?? []) visit(imported)
}
visit(entryKey)

const chunks = [...staticGraph].map((key) => {
	const file = manifest[key]!.file
	const source = readFileSync(join(DIST, file))
	return { key, file, gzipBytes: gzipSync(source).byteLength }
})
const gzipBytes = chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0)
// 650 KB from #225 until 2026-09-05. The Releases page (#764) costs ~1.5 KB of
// startup — 0.9 of it the domain contract every page's API client carries,
// the rest two route registrations and the atoms — after its route shell,
// loader and adapter had already been trimmed to nothing. main had meanwhile
// moved to 649.4 KB on its own, so the honest number is this one, not a
// contract with fields the page needs deleted from it.
// 653 KB from #776 (2026-09-07): the AI model detect contract is 0.3 KB of
// the same kind — a `MapleInternalApi` group every page's client carries —
// and main had reached 651.7 KB by then. The 33 vendor marks it added cost
// nothing: the icons chunk hash did not move, they are tree-shaken until a
// surface renders them.
// 682 KB from #783 (2026-09-07): the vendor marks stopped being free. The 33
// added with the detect contract cost nothing while nothing rendered them;
// the Agent Sessions list, header, rail and waterfall now do, and the mark
// table retains all forty in the `icons` chunk startup already loads. Measured
// against one base, the marks are +27.6 KB (651.5 → 679.1) and the rest of
// this page is ~0.3; main had reached 652.7 by then, so the honest number is
// the 680.3 this branch builds. Splitting the marks out was tried and does not
// work: `@/components/icons` re-exports them, so the barrel's own chunk keeps
// a static edge to them however they are reached. Dropping the marks from the
// model lanes is what buys the 27 KB back, not a lazy import.
// 684 KB from #800-#802 (2026-09-08): the Agent Sessions detail work — the
// leaner header, the model marks on the filters and the agent-time breakdown —
// lands in the route registry and the startup index chunk, not in a new
// dependency. main measures 683.8 with all three in, so this is the honest
// number rather than a target the pages would have to be cut back to.
// 685 KB from #806 (2026-09-08): the onboarding rebuild costs ~0.6 KB of
// startup — the setup checklist's hints for eight surfaces instead of four,
// the role/intent id literals and legacy-save maps in the quick-start atom the
// root gate reads, and one lab registry entry. The cards' own copy is split
// off so the route chunk carries it. main was at 683.4 KB.
// 687 KB from the Google Analytics integration (2026-09-09): 1.6 KB of startup,
// all of it the v2 domain contract every page's API client carries. Measured by
// registering and unregistering that one group against the same build — 686.2
// with `V2GoogleAnalyticsIntegrationsApiGroup` on `MapleApiV2`, 684.6 without —
// so the card, the catalog entry, the icon and the template-icon entry cost
// nothing measurable between them. It is the same category as the Releases and
// AI-detect contracts above, just larger: five endpoints and six schemas rather
// than one. The weight is the OpenAPI descriptions, and those are the public API
// documentation — cutting them to buy back a kilobyte of startup is the wrong
// trade. Splitting the group out of the client is not available either: every
// page's client is built from the whole `MapleApiV2` surface.
const maxGzipBytes = 687 * 1024
const budgetLabel = `${(maxGzipBytes / 1024).toFixed(1)} KB`

// Anything lazy-only: chat, replay, and every dev-only lab surface. The
// `src/routes/lab/*` shells are legitimately static (file-based routing has no
// per-environment tree), and `src/lab/registry.ts` is inlined into startup by
// design (the auth gate reads it) — only the routes' split chunks and any
// `src/lab/` module that becomes a chunk of its own are forbidden.
const forbiddenStartupPatterns = [
	/src\/lab\//,
	/src\/routes\/lab\/.*\?tsr-split/,
	/src\/components\/chat\/global-chat-(?:content|panel)/,
	/src\/routes\/chat\.tsx\?tsr-split/,
	/replay-player/,
	/replay-studio/,
	/effect-sdk\/dist\/replay-/,
]
const forbidden = [...staticGraph].filter((key) =>
	forbiddenStartupPatterns.some((pattern) => pattern.test(key)),
)

console.log(
	`Initial static JS: ${(gzipBytes / 1024).toFixed(1)} KB gzip across ${chunks.length} chunks (budget: ${budgetLabel})`,
)
for (const chunk of chunks.sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 10)) {
	console.log(`  ${(chunk.gzipBytes / 1024).toFixed(1).padStart(7)} KB  ${chunk.file}`)
}

if (forbidden.length > 0) {
	throw new Error(`Lazy-only code (chat/replay/lab) leaked into startup:\n${forbidden.join("\n")}`)
}
if (gzipBytes > maxGzipBytes) {
	throw new Error(`Initial static JS is ${(gzipBytes / 1024).toFixed(1)} KB gzip; budget is ${budgetLabel}`)
}
