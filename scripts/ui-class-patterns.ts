#!/usr/bin/env bun
/**
 * The repeated-class ratchet for the dashboard and Maple Local. A "pattern" is a class string (tokens
 * sorted, so order doesn't hide a copy) that appears in 3 or more page files across apps/web,
 * apps/local-ui and packages/views, outside the kits (packages/views/src/ui, each app's page/kit, the
 * lab): 3+ utilities, or 2+ that are all type (`text-xs text-muted-foreground`). Patterns are what the kit should own: `typography`, `hstack`/`vstack`,
 * or a component of their own.
 *
 * scripts/ui-class-patterns.json holds each pattern's file count. `--check` (CI) fails when a
 * pattern spreads to more files, a new one appears, or a count dropped without the file following.
 * Without `--check` it rewrites the file, refusing growth unless `--allow-increase`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"

const encodeJsonTabbed = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: "\t" }))

const root = join(import.meta.dir, "..")
/** Each scanned source root and the paths under it that are kit or fixtures, not pages. */
const SOURCES = [
	{ dir: join(root, "apps/web/src"), exempt: /^(page\/kit|lab)\// },
	{ dir: join(root, "apps/local-ui/src"), exempt: /^page\/kit\// },
	{ dir: join(root, "packages/views/src"), exempt: /^(ui|fixtures)\// },
]
const baselineFile = join(root, "scripts/ui-class-patterns.json")
const MIN_FILES = 3

function* walk(dir: string, isExempt: (path: string) => boolean): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry)
		if (statSync(path).isDirectory()) yield* walk(path, isExempt)
		else if (Str.endsWith(".ts")(path) && !isExempt(path) && !/\.(test|generated)\.ts$/.test(path))
			yield path
	}
}

const UTILITY =
	/^(?:[a-z0-9-]+:)*-?(?:flex|inline-flex|grid|block|inline|hidden|contents|items|justify|self|place|content|gap|space|p[xytrbl]?|m[xytrbl]?|w|h|size|min|max|text|font|leading|tracking|truncate|uppercase|lowercase|capitalize|tabular|italic|underline|whitespace|break|line|bg|border|rounded|shadow|ring|outline|opacity|overflow|relative|absolute|fixed|sticky|inset|top|left|right|bottom|z|shrink|grow|basis|order|col|row|divide|cursor|select|pointer|transition|duration|ease|animate|object|aspect|fill|stroke|sr|group|peer|antialiased|wrap|list|decoration|scroll|snap|touch|will|transform|translate|rotate|scale|origin|backdrop|blur|filter|isolate|mix|table)(?:-|$)/
const TYPE = /^(?:text|font|leading|tracking|truncate|uppercase|tabular|italic)/

/** A class string's pattern key, or undefined when it is not a pattern candidate. */
const patternOf = (raw: string): string | undefined => {
	const tokens = [...new Set(Arr.filter(Str.split(/\s+/)(Str.trim(raw)), Boolean))]
	if (tokens.length < 2 || !Arr.every(tokens, (token) => UTILITY.test(token))) return undefined
	const typeOnly = Arr.every(tokens, (token) => TYPE.test(Str.replace(/^(?:[a-z0-9-]+:)*/, "")(token)))
	if (tokens.length < 3 && !typeOnly) return undefined
	return Arr.join(tokens.sort(), " ")
}

const filesByPattern = new Map<string, Set<string>>()
const pageFiles = Arr.flatMap(SOURCES, ({ dir, exempt }) => [
	...walk(dir, (path) => exempt.test(relative(dir, path))),
])
for (const file of pageFiles) {
	const path = relative(root, file)
	for (const match of readFileSync(file, "utf8").matchAll(/"([^"\n]*)"|`([^`$\n]*)`/g)) {
		const pattern = patternOf(match[1] ?? match[2] ?? "")
		if (pattern === undefined) continue
		const files = filesByPattern.get(pattern) ?? new Set<string>()
		files.add(path)
		filesByPattern.set(pattern, files)
	}
}
const current = new Map(
	Arr.map(
		Arr.filter([...filesByPattern], ([, files]) => files.size >= MIN_FILES),
		([pattern, files]) => [pattern, files.size],
	),
)

const Baseline = Schema.Record(Schema.String, Schema.Number)
const previous = new Map(
	Rec.toEntries(Schema.decodeSync(Schema.fromJsonString(Baseline))(readFileSync(baselineFile, "utf8"))),
)

const hint = (pattern: string) =>
	Arr.every(Str.split(" ")(pattern), (token) => TYPE.test(Str.replace(/^(?:[a-z0-9-]+:)*/, "")(token)))
		? "`typography` (ui/typography)"
		: Str.split(" ")(pattern).includes("flex-col")
			? "`vstack` (ui/stack)"
			: Str.split(" ")(pattern).includes("flex") || Str.split(" ")(pattern).includes("inline-flex")
				? "`hstack` (ui/stack)"
				: "a kit component that owns this look"

const grew = Arr.map(
	Arr.filter([...current], ([pattern, count]) => count > (previous.get(pattern) ?? MIN_FILES - 1)),
	([pattern, count]) => ({ pattern, count, was: previous.get(pattern) ?? 0 }),
)
const shrank = Arr.map(
	Arr.filter([...previous], ([pattern, count]) => (current.get(pattern) ?? 0) < count),
	([pattern, count]) => ({ pattern, count: current.get(pattern) ?? 0, was: count }),
)

const report = (title: string, rows: ReadonlyArray<{ pattern: string; count: number; was: number }>) => {
	console.error(title)
	for (const { pattern, count, was } of rows.slice(0, 40)) {
		console.error(`  "${pattern}": ${was} -> ${count} files. Use ${hint(pattern)}.`)
		for (const file of [...(filesByPattern.get(pattern) ?? [])].slice(0, 5))
			console.error(`      ${file}`)
	}
	if (rows.length > 40) console.error(`  ... and ${rows.length - 40} more`)
}

if (grew.length > 0 && !process.argv.includes("--allow-increase")) {
	report(
		"These class strings now repeat in more page files. Use the kit instead of copying them (see apps/web/CLAUDE.md):\n",
		grew,
	)
	process.exit(1)
}

if (process.argv.includes("--check")) {
	if (shrank.length > 0) {
		report(
			"Fewer files repeat these class strings. Lower the baseline: run `bun run ui:patterns`.\n",
			shrank,
		)
		process.exit(1)
	}
	console.log(`ui-class-patterns: OK (${current.size} patterns)`)
} else {
	const sorted = Rec.fromEntries([...current].sort(([a], [b]) => Str.localeCompare(b)(a)))
	writeFileSync(baselineFile, `${encodeJsonTabbed(sorted)}\n`)
	const total = (counts: Iterable<number>) => Arr.reduce([...counts], 0, (sum, count) => sum + count)
	console.log(
		`ui-class-patterns: ${previous.size} -> ${current.size} patterns, ${total(previous.values())} -> ${total(current.values())} file uses`,
	)
}
