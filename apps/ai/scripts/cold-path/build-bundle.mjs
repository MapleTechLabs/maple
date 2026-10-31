// Build maple-ai the way the deploy does: alchemy's virtual entry (DO + Workflow
// class stubs), the Cloudflare Rolldown plugin, the runtime define, minify and
// `strictExecutionOrder: false`. Writes the bundle analyzer report beside it.
// PROBE=1 adds the offline graph probe as a second entry, for measure.mjs.
//   OUT=apps/ai/node_modules/.cache/cold-path/bundle bun apps/ai/scripts/cold-path/build-bundle.mjs
import { createRequire } from "node:module"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const alchemy = realpathSync("node_modules/alchemy")
const cloudflare = realpathSync("node_modules/@alchemy.run/cloudflare")
// Resolved through alchemy's own dependencies, the copy the deploy bundles with.
const alchemyRequire = createRequire(alchemy + "/package.json")
const { rolldown } = await import(alchemyRequire.resolve("rolldown"))
const { bundleAnalyzerPlugin } = await import(alchemyRequire.resolve("rolldown/experimental"))
const { default: cloudflareRolldown } = await import("@alchemy.run/cloudflare-runtime/rolldown")
const { makeEffectVirtualEntry } = await import(cloudflare + "/src/Workers/Sources/Rolldown.ts")

const cache = resolve("apps/ai/node_modules/.cache")
const out = resolve(process.env.OUT ?? "apps/ai/node_modules/.cache/cold-path/bundle")
if (!out.startsWith(cache + "/")) throw new Error("OUT must be under apps/ai/node_modules/.cache")
rmSync(out, { recursive: true, force: true })

const entryDir = resolve(cache, "cold-path-entry")
mkdirSync(entryDir, { recursive: true })
const entry = resolve(entryDir, "entry.ts")
writeFileSync(
	entry,
	makeEffectVirtualEntry(
		{ ChatSession: { kind: "durableObject" }, SecurityAuditWorkflow: { kind: "workflow" } },
		{ name: "maple", stage: "cold-path" },
	)(resolve("apps/ai/src/worker.ts")),
)

const build = await rolldown({
	input:
		process.env.PROBE === "1"
			? { worker: entry, probe: resolve("apps/ai/scripts/cold-path/graph-probe.ts") }
			: { worker: entry },
	external: ["lightningcss", "fsevents"],
	transform: { define: { "globalThis.__ALCHEMY_RUNTIME__": "true" } },
	moduleTypes: { ".sql": "text", ".txt": "text", ".html": "text" },
	plugins: [
		cloudflareRolldown({ compatibilityDate: "2026-10-01" }),
		bundleAnalyzerPlugin({ fileName: "analyze-data.json", format: "json" }),
		{
			// Static vs dynamic edges per module, which the analyzer report does not separate.
			name: "import-graph",
			generateBundle() {
				const graph = {}
				for (const id of this.getModuleIds()) {
					const info = this.getModuleInfo(id)
					graph[id] = {
						static: info?.importedIds ?? [],
						dynamic: info?.dynamicallyImportedIds ?? [],
					}
				}
				this.emitFile({ type: "asset", fileName: "import-graph.json", source: JSON.stringify(graph) })
			},
		},
	],
	checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
})
await build.write({
	format: "esm",
	sourcemap: "hidden",
	minify: true,
	keepNames: true,
	dir: out,
	strictExecutionOrder: false,
})
console.log("built", out)
