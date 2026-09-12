import { execFileSync } from "node:child_process"
import { createRequire } from "module"
import { realpathSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { resolve } from "path"
const alch = realpathSync(process.cwd() + "/node_modules/alchemy")
const req = createRequire(alch + "/package.json")
const { rolldown } = await import(req.resolve("rolldown"))
const cfMod = await import(req.resolve("@alchemy.run/cloudflare-runtime/rolldown"))
const cloudflareRolldown = cfMod.default
console.log("rolldown from:", req.resolve("rolldown"))

const seo = process.env.SEO ?? "0"
const out = process.env.OUT ?? "apps/api/node_modules/.cache/cold-path/bundle"
let input = {
	worker: "apps/api/src/worker.ts",
	probe: "apps/api/scripts/cold-path/graph-probe.ts",
	telemetry: "apps/api/scripts/cold-path/telemetry-probe.ts",
}
if (process.env.STARTUP === "1") {
	const { makeEffectVirtualEntry } = await import(alch + "/src/Cloudflare/Workers/Sources/Rolldown.ts")
	const entryDir = "apps/api/node_modules/.cache/maple-startup-entry"
	mkdirSync(entryDir, { recursive: true })
	const entry = entryDir + "/entry.ts"
	writeFileSync(
		entry,
		makeEffectVirtualEntry(
			{ ClickHouseSchemaApplyWorkflow: { kind: "workflow" } },
			{ name: "maple", stage: "startup-check" },
		)(resolve("apps/api/src/worker.ts")),
	)
	input = { worker: entry }
}
if (process.env.WORKER_PROBE === "1") input = { worker: "apps/api/scripts/cold-path/workerd-probe.ts" }
// Old hashed chunks must not be mistaken for the current graph by the probes.
// Only delete our explicit cache output, never an arbitrary caller's directory.
if (!resolve(out).startsWith(resolve("apps/api/node_modules/.cache") + "/"))
	throw new Error("Output must be under apps/api/node_modules/.cache")
rmSync(out, { recursive: true, force: true })
// Rebuild an earlier revision's runtime source without modifying the checkout.
// Dependencies and benchmark fixtures remain fixed for a controlled comparison.
const baselineRef = process.env.BASELINE_REF
const overrides = new Map()
if (baselineRef) {
	const changed = execFileSync(
		"git",
		["diff", "--name-only", baselineRef, "--", "apps/api/src", "packages/effect-sdk/src"],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean)
	for (const file of changed) {
		overrides.set(
			resolve(file),
			execFileSync("git", ["show", `${baselineRef}:${file}`], { encoding: "utf8" }),
		)
	}
}
const sourceOverride = {
	name: "benchmark-baseline",
	load(id) {
		return overrides.get(id)
	},
}
const build = await rolldown({
	input,
	external: ["lightningcss", "fsevents"],
	plugins: [
		sourceOverride,
		cloudflareRolldown({ compatibilityDate: "2026-04-08", compatibilityFlags: ["nodejs_compat"] }),
	],
	checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
})
await build.write({
	format: "esm",
	sourcemap: "hidden",
	minify: true,
	keepNames: true,
	dir: out,
	...(!(seo === undefined) ? { strictExecutionOrder: seo === "1" } : undefined),
})
console.log("built", out)
