// Copied into an isolated directory by check-package.ts. Nothing here may
// resolve dependencies or source files from Maple's workspace.
import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import * as CH from "@maple-dev/effect-clickhouse"
import * as F from "@maple-dev/effect-clickhouse/expr"
import * as T from "@maple-dev/effect-clickhouse/types"
import * as Bench from "@maple-dev/effect-clickhouse/benchmark"
import { makeHttpClient } from "@maple-dev/effect-clickhouse/benchmark/http"
import { runCli } from "@maple-dev/effect-clickhouse/benchmark/cli"
import * as SQL from "@maple-dev/effect-clickhouse/sql"

const events = CH.table("events", { id: T.uint64, name: T.string })
const query = CH.from(events)
	.select(($) => ({ id: CH.toString($.id), name: F.lower_($.name) }))
	.where(($) => [$.name.eq(CH.param.string("name"))])
const compiled = await Effect.runPromise(CH.compile(query, { name: "O'Reilly" }))
assert.match(compiled.sql, /FROM events/)
assert.equal(compiled.rowSchemaSource, "derived")
const rows = await Effect.runPromise(compiled.decodeRows([{ id: "18446744073709551615", name: "maple" }]))
const typed: readonly { readonly id: string; readonly name: string }[] = rows
assert.equal(typed[0]?.id, "18446744073709551615")
assert.deepEqual(await Effect.runPromise(compiled.encodeRows(rows)), rows)
assert.equal(SQL.compile(SQL.str("O'Reilly")), "'O\\'Reilly'")
assert.equal(T.custom("String", Schema.String).sql, "String")
assert.equal(T.untyped("Tuple(String)").sql, "Tuple(String)")
const length = CH.defineFn<[CH.Expr<string>], number>("length", T.uint64)
assert.equal(SQL.compile(length(CH.lit("abc")).toFragment()), "length('abc')")
const invalid = Effect.runSync(Effect.exit(CH.compile(query, {})))
assert.equal(invalid._tag, "Failure")

// Compile-only negative assertions verify that published declarations retain
// column checking and inferred row types.
const checkTypes = () => {
	// @ts-expect-error an unknown column must not typecheck
	CH.from(events).select("missing")
	// @ts-expect-error the selected ID is a string after toString
	const id: number = rows[0]!.id
	void id
}
void checkTypes
console.log("Isolated tarball imports, types, compilation and codecs passed")

const suite = await Effect.runPromise(
	Bench.defineSuite({
		name: "consumer",
		dataset: "snapshot",
		cases: [
			Bench.query({
				id: "events/name",
				inputs: { name: "Maple" },
				compile: (inputs) => CH.compile(query, inputs),
				results: "unordered",
			}),
		],
	}),
)
assert.equal(suite.samples[0]?.id, "events/name")
assert.match(suite.samples[0]!.sampleSql, /Maple/)
assert.equal(
	await Effect.runPromise(makeHttpClient({ url: "http://localhost:8123" }).target),
	"http://localhost:8123",
)
assert.equal(typeof runCli, "function")
