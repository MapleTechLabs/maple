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
// 2,330 KB on 2026-10-20, measured at 2,321.5 after the cutover. Pages are not split yet, so the
// index chunk carries most of it; lower this as pages move behind lazy imports.
const maxGzipBytes = 2330 * 1024
const budgetLabel = `${(maxGzipBytes / 1024).toFixed(1)} KB`

// Code that is lazy today and must stay out of startup: lab pages, the chart host, the 3D and
// ELK service maps, replay, and the shiki/mermaid/katex renderers.
const forbiddenStartupPatterns = [
	/src\/lab\/(?:entries|charts)\//,
	/src\/charts\/chart-host/,
	/src\/page\/service-map\/three\//,
	/service-map-elk/,
	/src\/page\/replays\/kit\/replay-engines/,
	/effect-sdk\/dist\/replay-/,
	/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:shiki|@shikijs|mermaid|katex)\//,
]
const forbidden = [...staticGraph].filter((key) =>
	forbiddenStartupPatterns.some((pattern) => pattern.test(key)),
)

console.log(
	`Initial static JS: ${(gzipBytes / 1024).toFixed(1)} KB gzip across ${chunks.length} chunks (budget: ${budgetLabel})`,
)
// Over budget, list every chunk with its source key so the culprit is in the CI log.
const overBudget = gzipBytes > maxGzipBytes
for (const chunk of chunks.sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, overBudget ? undefined : 10)) {
	const label = overBudget ? `${chunk.file}  ${chunk.key}` : chunk.file
	console.log(`  ${(chunk.gzipBytes / 1024).toFixed(1).padStart(7)} KB  ${label}`)
}

if (forbidden.length > 0) {
	throw new Error(`Lazy-only code leaked into startup:\n${forbidden.join("\n")}`)
}
if (gzipBytes > maxGzipBytes) {
	throw new Error(`Initial static JS is ${(gzipBytes / 1024).toFixed(1)} KB gzip; budget is ${budgetLabel}`)
}
