import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const temporary = mkdtempSync(join(root, ".docs-check-"))
try {
	const examples = new Map()
	for (const page of readdirSync(join(root, "docs"))) {
		if (!page.endsWith(".md")) continue
		const markdown = readFileSync(join(root, "docs", page), "utf8")
		for (const match of markdown.matchAll(/```ts title="([a-z-]+\.ts)"\n([\s\S]*?)\n```/g)) {
			const [, name, source] = match
			assert(!examples.has(name), `Duplicate example filename: ${name}`)
			examples.set(name, source)
			writeFileSync(join(temporary, name), source)
		}
	}
	assert(
		examples.has("benchmark-suite.ts") && examples.has("benchmark-runner.ts"),
		"Expected benchmark suite and runner examples",
	)
	assert(examples.size >= 11, "Expected the complete getting-started, client, and recipe examples")
	// Resolve the same public exports a package consumer uses, including built .d.mts files.
	writeFileSync(
		join(temporary, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				types: ["node"],
			},
			include: ["*.ts"],
		}),
	)
	const tsc = join(root, "node_modules/.bin/tsc")
	execFileSync(tsc, ["-p", join(temporary, "tsconfig.json")], { cwd: root, stdio: "inherit" })
	writeFileSync(
		join(temporary, "verify.ts"),
		`
import assert from "node:assert/strict"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-clickhouse"
import { Events } from "./schema"
const sql = (query: { sql: string }) => query.sql.replace(/\\s+/g, " ").trim()
const quick = await import("./quick-start")
assert.equal(quick.compiled.rowSchemaSource, "derived")
assert.deepEqual(quick.rows, [{ name: "checkout", p95: 420, count: 3 }])
const errors = await import("./compile-errors")
assert.equal(errors.outcome.ok, false)
if (!errors.outcome.ok) assert.equal(errors.outcome.code, "UnresolvedParam")
const buckets = await import("./time-buckets")
assert.equal(buckets.compiled.tenantScope, "single-tenant")
assert.match(sql(buckets.compiled), /INTERVAL 300 SECOND/)
assert.match(sql(buckets.compiled), /Timestamp < '2026-01-01 01:00:00'/)
assert.deepEqual(await Effect.runPromise(buckets.compiled.decodeRows([])), [])
const filters = await import("./optional-filters")
assert.match(sql(filters.compiled), /Name IN \\('checkout'\\)/)
assert.match(sql(filters.compiled), /DurationMs >= 0/)
const empty = CH.compileUnsafe(filters.buildQuery([]), {
  orgId: "org_123", startTime: "2026-01-01 00:00:00", endTime: "2026-01-02 00:00:00",
})
assert.equal(empty.tenantScope, "single-tenant")
assert.doesNotMatch(empty.sql, /Name IN/)
const aggregate = await import("./aggregate-filter")
assert.match(sql(aggregate.compiled), /GROUP BY name HAVING count >= 10 ORDER BY/)
assert.equal(aggregate.compiled.rowSchemaSource, "derived")
const page = await import("./pagination")
assert.match(sql(page.compiled), /ORDER BY count DESC, name ASC LIMIT 25 OFFSET 25/)
const ids = await import("./large-ids")
assert.match(sql(ids.compiled), /toString\\(Id\\) AS id/)
assert.equal(ids.rows[0]?.id, "18446744073709551615")
const replaced = CH.compileUnsafe(CH.from(Events).select("Name")
  .where(($) => [$.OrgId.eq("org_123")])
  .where(($) => [$.Name.eq("checkout")]), {})
assert.equal(replaced.tenantScope, "cross-tenant")
assert.doesNotMatch(replaced.sql, /OrgId =/)
const benchmark = await import("./benchmark-suite")
const suite = await Effect.runPromise(benchmark.default)
assert.equal(suite.source, "events")
assert.equal(suite.dataset, "events-snapshot-v1")
assert.equal(suite.samples.length, 1)
assert.equal(suite.samples[0]?.id, "events/by-name")
assert.equal(suite.samples[0]?.results, "unordered")
assert.deepEqual(JSON.parse(suite.samples[0]!.inputs!), { name: "checkout" })
assert.match(suite.samples[0]!.sampleSql, /name = 'checkout'/)
console.log("Markdown example behavior checks passed")
`,
	)
	execFileSync("bun", [join(temporary, "verify.ts")], { cwd: root, stdio: "inherit" })
	const live = process.env.CLICKHOUSE_DOCS_LIVE === "1"
	if (live) execFileSync("bun", [join(temporary, "run-query.ts")], { cwd: root, stdio: "inherit" })
	console.log(
		`doc examples ok (${examples.size} files typechecked; network example ${live ? "executed" : "not executed"})`,
	)
} finally {
	rmSync(temporary, { recursive: true, force: true })
}
