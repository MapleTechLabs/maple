import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"
import { dialectCases, typeCases } from "./dialect-cases"

// Discover methods and descriptors from built exports; canonical function names
// come from the explicit barrel (the root gives some of these friendly aliases).
const barrel = readFileSync(new URL("../src/ch/functions/index.ts", import.meta.url), "utf8")
const exports = [...barrel.matchAll(/export \{([\s\S]*?)\} from "[^"\n]+"/g)]
const functions = exports.flatMap((match) =>
	match[1]!
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name && !name.startsWith("type "))
		.map((name) => `function:${name}`),
)
const methods = (object: CH.CHQuery<any, any, any> | CH.CHUnionQuery<any>, prefix: string) =>
	Object.entries(object)
		.filter(([, value]) => typeof value === "function")
		.map(([name]) => `${prefix}:${name}`)
const one = CH.from(CH.table("system.one", {})).select(() => ({ n: CH.lit(1) }))
const types = Object.keys(T).map((name) => `type:${name}`)

const exemptions = {
	"type:CHNumber": "Wire codec, exercised by all numeric descriptor fixtures in both quote64 modes.",
	"type:custom":
		"Caller-defined SQL types and codecs; no finite dialect contract. Public tarball smoke exercises the factory.",
	"type:untyped":
		"Explicitly unvalidated escape hatch; no decoding guarantee. Public tarball smoke exercises the factory.",
}

export const dialectInventory = [
	...new Set([
		...functions,
		...types,
		...methods(one, "query"),
		...methods(CH.unionAll(one, one), "union"),
	]),
].sort()

describe("dialect coverage manifest", () => {
	it("covers every function, query/union method and type, or records a reason", () => {
		expect(exports.length, "function barrel changed syntax; update inventory extraction").toBe(
			(barrel.match(/^export /gm) ?? []).length,
		)
		expect(functions.length).toBeGreaterThan(0)
		const cases = [...dialectCases, ...typeCases]
		const covered = new Set(cases.flatMap((fixture) => fixture.covers))
		expect(cases.length).toBeGreaterThan(0)
		expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
		expect(
			dialectInventory.filter((name) => !covered.has(name) && !Object.hasOwn(exemptions, name)),
			"missing live coverage",
		).toEqual([])
		expect(
			[...covered, ...Object.keys(exemptions)].filter((name) => !dialectInventory.includes(name)),
			"stale manifest entries",
		).toEqual([])
		expect(
			Object.keys(exemptions).filter((name) => covered.has(name)),
			"remove exemptions once covered",
		).toEqual([])
		for (const reason of Object.values(exemptions)) expect(reason.length).toBeGreaterThan(20)
	})
})
