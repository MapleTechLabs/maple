// Regenerates effect.json from the installed @effect/tsgo presets. Run after bumping @effect/tsgo.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const findUp = (dir, name) => {
	const candidate = join(dir, "node_modules", name)
	if (existsSync(candidate)) return candidate
	const parent = dirname(dir)
	return parent === dir ? undefined : findUp(parent, name)
}
const tsgoDir = findUp(here, "@effect/tsgo")
if (tsgoDir === undefined) throw new Error("@effect/tsgo is not installed")
const tsgo = (f) => JSON.parse(readFileSync(join(tsgoDir, `oxlint-presets/${f}.json`), "utf8")).rules
const upstream = { ...tsgo("strict") }
for (const k of Object.keys(tsgo("effect-native"))) upstream[k] = "error"
const version = JSON.parse(readFileSync(join(tsgoDir, "package.json"), "utf8")).version

// Our decisions on top of upstream: [rule, value, reason?]
const effectDecisions = [
	[
		"effecttsgo/any-unknown-in-error-context",
		"error",
		"Error context is schema-backed; `unknown` causes go in `Schema.Defect()`.",
	],
	["effecttsgo/nested-effect-gen-yield", "error"],
	// Opt-in rules that are in neither upstream preset.
	["effecttsgo/effect-do-notation", "error"],
	["effecttsgo/effect-try-without-catch", "error"],
	["effecttsgo/map-map-error-to-map-both", "error"],
	["effecttsgo/provide-merge-all-to-array", "error"],
	["effecttsgo/service-not-as-class", "error"],
	["effecttsgo/strict-effect-provide", "error"],
	["effecttsgo/type-union-to-schema-union", "error"],
	["effecttsgo/yield-in-call-argument", "error"],
	[
		"effecttsgo/unstable-api-usage",
		"off",
		"`effect/unstable/*` (HttpApi, HttpClient, RPC) is the normal surface in Effect 4; version bumps are where breakage shows.",
	],
	[
		"effecttsgo/schema-number",
		"off",
		"JSON can't carry NaN/Infinity, and a blanket `Schema.Finite` turns a computed NaN into a decode failure.",
	],
	[
		"effecttsgo/schema-class-missing-brand",
		"off",
		"Schema classes are told apart by fields and `_tag`; a brand on every class is noise.",
	],
	[
		"effecttsgo/global-date",
		"off",
		"`new Date(ts)` to parse or format is pure; `global-date-in-effect` covers clock reads in Effect code.",
	],
	[
		"effecttsgo/async-function",
		"off",
		"Worker handlers, Durable Object methods and Promise-based library hooks have to be async.",
	],
	[
		"effecttsgo/node-builtin-import",
		"off",
		"node:crypto, node:fs and node:path are often the intended APIs on servers and Workers.",
	],
	[
		"effecttsgo/schema-sync",
		"off",
		"Flags every sync decode, mostly at non-Effect boundaries; `schema-sync-in-effect` covers the case that matters.",
	],
]
const tsDecisions = [
	[
		"typescript/no-misused-spread",
		"off",
		"Fires on `new X({ ...x })`, which is how Schema classes are copied.",
	],
	[
		"typescript/strict-boolean-expressions",
		[
			"error",
			{
				allowString: true,
				allowNumber: false,
				allowNullableObject: true,
				allowNullableBoolean: true,
				allowNullableString: true,
				allowNullableNumber: false,
				allowNullableEnum: false,
				allowAny: true,
			},
		],
		"0 and NaN are falsy, so `if (count)` or `ts || fallback` on a number hides real values; an object in a condition is always truthy.",
	],
	...[
		"await-thenable",
		"no-floating-promises",
		"restrict-template-expressions",
		"require-array-sort-compare",
	].map((r) => [`typescript/${r}`, "error"]),
	["typescript/switch-exhaustiveness-check", ["error", { considerDefaultExhaustiveForUnions: true }]],
	...[
		"no-unnecessary-type-assertion",
		"no-unnecessary-type-arguments",
		"no-deprecated",
		"use-unknown-in-catch-callback-variable",
		"return-await",
		"no-unnecessary-template-expression",
		"no-misused-promises",
		"no-unsafe-enum-comparison",
		"only-throw-error",
		"no-base-to-string",
		"no-redundant-type-constituents",
		"no-useless-default-assignment",
		"no-implied-eval",
		"no-for-in-array",
		"no-array-delete",
		"no-mixed-enums",
		"no-meaningless-void-operator",
		"no-duplicate-type-constituents",
		"no-unsafe-unary-minus",
		"prefer-reduce-type-parameter",
	].map((r) => [`typescript/${r}`, "error"]),
	[
		"typescript/no-unsafe-argument",
		"error",
		"`any` is typed at its source (decodes, guards, typed env), so it never flows on silently.",
	],
	...["no-unsafe-assignment", "no-unsafe-call", "no-unsafe-member-access", "no-unsafe-return"].map((r) => [
		`typescript/${r}`,
		"error",
	]),
]
const pluginDecisions = [
	[
		"effect-strict/no-try-catch",
		"error",
		"Syntax halves of the Effect error convention (plugins/effect-strict.mjs).",
	],
	["effect-strict/no-effect-die", "error"],
	["effect-strict/no-date-parse", "error"],
	["effect-strict/no-record-string-any", "error"],
]
const decided = new Set([...effectDecisions, ...tsDecisions].map(([r]) => r))
const j = (v) => JSON.stringify(v)
const lines = []
const emit = (rows, ind = "\t\t") =>
	rows.forEach(([r, v, why]) => {
		if (why) lines.push(`${ind}// ${why}`)
		lines.push(`${ind}${j(r)}: ${j(v)},`)
	})
lines.push(`{`)
lines.push(
	`\t// Generated by scripts/sync-effect-preset.mjs from @effect/tsgo ${version}; edit the script, not this file.`,
)
lines.push(`\t"plugins": ["eslint", "typescript", "effecttsgo"],`)
lines.push(`\t"jsPlugins": ["./plugins/effect-strict.mjs"],`)
lines.push(`\t"options": { "typeAware": true },`)
lines.push(`\t"rules": {`)
lines.push(
	`\t\t// --- @effect/tsgo strict + effect-native, all at error (CI runs --quiet, so warn enforces nothing).`,
)
emit(
	Object.keys(upstream)
		.sort()
		.filter((r) => !decided.has(r))
		.map((r) => [r, "error"]),
)
lines.push(``, `\t\t// --- Where we differ from upstream.`)
emit(effectDecisions)
lines.push(``, `\t\t// --- Type-aware TypeScript bug rules.`)
emit(tsDecisions)
lines.push(``, `\t\t// --- effect-strict plugin.`)
emit(pluginDecisions)
lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "")
const off = (rules) => Object.fromEntries(rules.map((r) => [r, "off"]))
const hostGlobals = [
	"crypto-random-uuid",
	"global-console",
	"global-fetch",
	"global-random",
	"global-timers",
	"new-promise",
	"process-env",
].map((r) => `effecttsgo/${r}`)
const unsafe = [
	"no-unsafe-argument",
	"no-unsafe-assignment",
	"no-unsafe-call",
	"no-unsafe-member-access",
	"no-unsafe-return",
].map((r) => `typescript/${r}`)
const overrides = [
	{
		why: "Tests may use host globals, inline fixtures and intentionally partial layers; production code may not.",
		files: [
			"**/*.test.ts",
			"**/*.test.tsx",
			"**/*.spec.ts",
			"**/*.spec.tsx",
			"**/test/**",
			"**/tests/**",
			"**/__tests__/**",
		],
		rules: off([
			...hostGlobals,
			"effecttsgo/any-unknown-in-error-context",
			"effecttsgo/global-date-in-effect",
			"effecttsgo/global-json",
			"effecttsgo/global-json-in-effect",
			"effecttsgo/schema-sync-in-effect",
			"effecttsgo/unsafe-effect-type-assertion",
			"effecttsgo/strict-effect-provide",
			"effecttsgo/yield-in-call-argument",
			"typescript/require-array-sort-compare",
			"typescript/restrict-template-expressions",
			...unsafe,
		]),
	},
	{
		why: "Ops scripts, benches and build configs run as plain async Node/Bun, not Effect programs.",
		files: ["scripts/**", "**/scripts/**", "**/bench/**", "**/*.config.ts", "**/*.config.mts"],
		rules: off([
			...hostGlobals,
			"effecttsgo/prefer-effect-array",
			"effecttsgo/prefer-effect-record",
			"effecttsgo/prefer-effect-string",
			"effect-strict/no-try-catch",
		]),
	},
	{
		why: "Untyped JavaScript: every import is `any` to the type-aware lint.",
		files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
		rules: off(unsafe),
	},
]
lines.push(`\t},`, `\t"overrides": [`)
overrides.forEach(({ why, ...o }, i) => {
	lines.push(`\t\t// ${why}`)
	const body = JSON.stringify(o, null, "\t")
		.split("\n")
		.map((l) => "\t\t" + l)
		.join("\n")
	lines.push(body + (i < overrides.length - 1 ? "," : ""))
})
lines.push(`\t]`, `}`, ``)
writeFileSync(join(here, "effect.json"), lines.join("\n"))
const oxfmt = findUp(here, ".bin/oxfmt")
if (oxfmt !== undefined) execFileSync(oxfmt, [join(here, "effect.json")])
console.log("rules:", lines.filter((l) => /^\t\t"[a-z-]+\//.test(l)).length)
