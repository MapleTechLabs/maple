import * as S from "@maple-dev/effect-orm/schema"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { latestSnapshotStatements } from "../generated/clickhouse-schema"
import * as Datasources from "../tinybird/datasources"
import * as Materializations from "../tinybird/materializations"

// The DDL effect-orm renders from the same definitions must match what the emitter ships,
// so moving the self-managed and CLI schemas onto effect-orm migrations changes nothing.

const nameOf = (sql: string): string =>
	sql.match(/CREATE (?:MATERIALIZED VIEW|TABLE) (?:IF NOT EXISTS )?(?:\S+\.)?`?(\w+)`?/)?.[1] ?? sql

/** `body` split at commas outside parentheses and quotes. */
const topLevelParts = (body: string): Array<string> => {
	const parts: Array<string> = []
	let depth = 0
	let quoted = false
	let start = 0
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]
		if (ch === "'" && body[i - 1] !== "\\") quoted = !quoted
		else if (!quoted && ch === "(") depth++
		else if (!quoted && ch === ")") depth--
		else if (!quoted && depth === 0 && ch === ",") {
			parts.push(body.slice(start, i).trim())
			start = i + 1
		}
	}
	parts.push(body.slice(start).trim())
	return parts
}

// Text differences ClickHouse reads the same way: `IF NOT EXISTS`, quoting, whitespace,
// `MergeTree()` vs `MergeTree`, and the order of skip indexes.
const normalize = (sql: string): string => {
	const flat = sql
		.replace(/IF NOT EXISTS /g, "")
		.replace(/`/g, "")
		.replace(/MergeTree\(\)/g, "MergeTree")
		.replace(/\s+/g, " ")
		.replace(/\( /g, "(")
		.replace(/ \)/g, ")")
		.trim()
	if (!flat.startsWith("CREATE TABLE")) return flat
	const open = flat.indexOf("(")
	let depth = 0
	let close = open
	for (; close < flat.length; close++) {
		if (flat[close] === "(") depth++
		else if (flat[close] === ")" && --depth === 0) break
	}
	const parts = topLevelParts(flat.slice(open + 1, close))
	const columns = parts.filter((part) => !part.startsWith("INDEX "))
	const indexes = parts.filter((part) => part.startsWith("INDEX ")).sort()
	return `${flat.slice(0, open + 1)}${[...columns, ...indexes].join(", ")}${flat.slice(close)}`
}

const objects: ReadonlyArray<S.SchemaObject> = [
	...new Set(
		[...Object.values(Datasources), ...Object.values(Materializations)].flatMap((value) =>
			S.isSchemaObject(value) ? [value] : [],
		),
	),
]

/** Where the emitter is wrong and effect-orm is right; each needs a migration to fix live tables. */
const KNOWN_DIFFERENCES = {
	// The emitter drops ENGINE_VER, so live self-managed and CLI tables keep no version.
	session_replays: "ENGINE = ReplacingMergeTree(Version)",
} satisfies Record<string, string>

describe("effect-orm DDL parity", () => {
	const rendered = new Map(
		S.renderSchema(Effect.runSync(S.entitiesOf(objects))).map((sql) => [nameOf(sql), normalize(sql)]),
	)
	const shipped = new Map(latestSnapshotStatements.map((sql) => [nameOf(sql), normalize(sql)]))

	it("renders every object the emitter ships, and nothing else", () => {
		expect([...rendered.keys()].sort()).toEqual([...shipped.keys()].sort())
	})

	it("renders each object as the emitter does, apart from the known differences", () => {
		const differing = [...shipped]
			.filter(([name, sql]) => rendered.get(name) !== sql)
			.map(([name]) => name)
		expect(differing.sort()).toEqual(Object.keys(KNOWN_DIFFERENCES).sort())
		for (const [name, fragment] of Object.entries(KNOWN_DIFFERENCES)) {
			expect(rendered.get(name)).toContain(fragment)
			expect(shipped.get(name)).not.toContain(fragment)
		}
	})
})
