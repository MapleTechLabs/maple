import * as S from "@maple-dev/effect-orm/schema"
import { Effect, Array as Arr, Record as Rec, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { latestSnapshotStatements } from "../generated/clickhouse-schema"
import { clickHouseOnlyColumns } from "./clickhouse-only-columns"
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
			parts.push(Str.trim(Str.slice(start, i)(body)))
			start = i + 1
		}
	}
	parts.push(Str.trim(Str.slice(start)(body)))
	return parts
}

// Text differences ClickHouse reads the same way: `IF NOT EXISTS`, quoting, whitespace,
// `MergeTree()` vs `MergeTree`, and the order of skip indexes.
const normalize = (sql: string): string => {
	const flat = Str.trim(
		Str.replace(
			/ \)/g,
			")",
		)(
			Str.replace(
				/\( /g,
				"(",
			)(
				Str.replace(
					/\s+/g,
					" ",
				)(
					Str.replace(
						/MergeTree\(\)/g,
						"MergeTree",
					)(Str.replace(/`/g, "")(Str.replace(/IF NOT EXISTS /g, "")(sql))),
				),
			),
		),
	)
	if (!Str.startsWith("CREATE TABLE")(flat)) return flat
	const open = flat.indexOf("(")
	let depth = 0
	let close = open
	for (; close < flat.length; close++) {
		if (flat[close] === "(") depth++
		else if (flat[close] === ")" && --depth === 0) break
	}
	const parts = topLevelParts(Str.slice(open + 1, close)(flat))
	const columns = Arr.filter(parts, (part) => !Str.startsWith("INDEX ")(part))
	const indexes = Arr.filter(parts, (part) => Str.startsWith("INDEX ")(part)).sort()
	return `${Str.slice(0, open + 1)(flat)}${Arr.join([...columns, ...indexes], ", ")}${Str.slice(close)(flat)}`
}

const objects: ReadonlyArray<S.SchemaObject> = [
	...new Set(
		Arr.flatMap([...Rec.values(Datasources), ...Rec.values(Materializations)], (value) =>
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
		Arr.map(S.renderSchema(Effect.runSync(S.entitiesOf(objects))), (sql) => [
			nameOf(sql),
			normalize(sql),
		]),
	)
	const shippedWithClickHouseOnly = new Map(
		Arr.map(latestSnapshotStatements, (sql) => [nameOf(sql), normalize(sql)]),
	)
	// The emitter appends ClickHouse-only columns that the shared definitions leave out.
	const shipped = new Map(
		Arr.map([...shippedWithClickHouseOnly], ([name, sql]) => [
			name,
			Arr.reduce(clickHouseOnlyColumns.get(name) ?? [], sql, (acc, column) =>
				Str.replace(`, ${column}`, "")(acc),
			),
		]),
	)

	it("ships each ClickHouse-only column", () => {
		for (const [name, columns] of clickHouseOnlyColumns) {
			for (const column of columns) {
				expect(shippedWithClickHouseOnly.get(name)).toContain(column)
				expect(rendered.get(name)).not.toContain(column)
			}
		}
	})

	it("renders every object the emitter ships, and nothing else", () => {
		expect([...rendered.keys()].sort()).toEqual([...shipped.keys()].sort())
	})

	it("renders each object as the emitter does, apart from the known differences", () => {
		const differing = Arr.map(
			Arr.filter([...shipped], ([name, sql]) => rendered.get(name) !== sql),
			([name]) => name,
		)
		expect(differing.sort()).toEqual(Rec.keys(KNOWN_DIFFERENCES).sort())
		for (const [name, fragment] of Rec.toEntries(KNOWN_DIFFERENCES)) {
			expect(rendered.get(name)).toContain(fragment)
			expect(shipped.get(name)).not.toContain(fragment)
		}
	})
})
