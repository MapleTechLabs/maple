#!/usr/bin/env bun
/**
 * Rewrites scripts/oxlint-plugins/ui-kit-baseline.json: the per-file counts the kit-first lint
 * rules (scripts/oxlint-plugins/ui-kit-rules.mjs) still tolerate. Run it after fixing violations;
 * lint reports a file whose count dropped until the baseline follows.
 *
 * The baseline only shrinks: an entry that would grow, or a new file, fails unless you pass
 * `--allow-increase` (for a rule landing, never for new code).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"

const root = join(import.meta.dir, "..")
const baselineFile = join(root, "scripts/oxlint-plugins/ui-kit-baseline.json")
const allowIncrease = process.argv.includes("--allow-increase")

const RULES = [
	"no-arbitrary-text-size",
	"no-kit-styles-in-pages",
	"no-raw-color",
	"no-raw-control",
	"no-raw-heading",
]

const lint = Bun.spawnSync(
	[
		"./node_modules/.bin/oxlint",
		"-c",
		".oxlintrc.json",
		"--format",
		"json",
		"apps/web/src",
		"packages/ui/src",
	],
	{ cwd: root, env: { ...process.env, MAPLE_UI_BASELINE: "off" }, stdout: "pipe", stderr: "inherit" },
)
const Report = Schema.Struct({
	diagnostics: Schema.Array(
		Schema.Struct({ code: Schema.optional(Schema.String), filename: Schema.String }),
	),
})
const Baseline = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number))
const { diagnostics } = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(lint.stdout.toString())

const counts: Record<string, Record<string, number>> = Object.fromEntries(RULES.map((rule) => [rule, {}]))
for (const { code, filename } of diagnostics) {
	const rule = code?.match(/^maple\((.+)\)$/)?.[1]
	if (rule === undefined || !RULES.includes(rule)) continue
	counts[rule][filename] = (counts[rule][filename] ?? 0) + 1
}

const previous = Schema.decodeUnknownSync(Schema.fromJsonString(Baseline))(readFileSync(baselineFile, "utf8"))
const grew = RULES.flatMap((rule) =>
	Object.entries(counts[rule])
		.filter(([file, count]) => count > (previous[rule]?.[file] ?? 0))
		.map(([file, count]) => `  ${rule}  ${file}: ${previous[rule]?.[file] ?? 0} → ${count}`),
)
if (grew.length > 0 && !allowIncrease) {
	console.error(
		"These files gained kit-rule violations. Fix them (use the kit component the lint message names) instead of growing the baseline:\n",
	)
	for (const line of grew.slice(0, 40)) console.error(line)
	if (grew.length > 40) console.error(`  … and ${grew.length - 40} more`)
	process.exit(1)
}

const sorted = Object.fromEntries(
	RULES.map((rule) => [
		rule,
		Object.fromEntries(Object.entries(counts[rule]).sort(([a], [b]) => a.localeCompare(b))),
	]),
)
writeFileSync(baselineFile, `${JSON.stringify(sorted, null, "\t")}\n`)

const total = (record: typeof Baseline.Type) =>
	Object.values(record).reduce((sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0), 0)
console.log(`ui-kit baseline: ${total(previous)} → ${total(sorted)} tolerated violations`)
