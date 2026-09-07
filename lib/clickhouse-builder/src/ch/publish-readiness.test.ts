import { DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as CH from "./index"
import * as T from "./types"

const One = CH.table("system.one", {})
const Events = CH.table("events", { OrgId: T.string, Id: T.uint8, Name: T.string }, { tenantColumn: "OrgId" })
const Other = CH.table("other", Events.columns, { tenantColumn: "OrgId" })
const branch = (org: string) =>
	CH.from(Events)
		.select("Name")
		.where(($) => [$.OrgId.eq(org)])

describe("publishing regressions", () => {
	it("requires a tenant constraint on every joined source", () => {
		const base = CH.from(Events, "e")
			.innerJoin(Other, "o", (e, o) => e.Id.eq(o.Id))
			.select(($) => ({ name: $.o.Name }))
		expect(
			CH.compileUnsafe(
				base.where(($) => [$.OrgId.eq("a")]),
				{},
			).tenantScope,
		).toBe("cross-tenant")
		expect(
			CH.compileUnsafe(
				base.where(($) => [$.OrgId.eq("a"), $.o.OrgId.eq("a")]),
				{},
			).tenantScope,
		).toBe("single-tenant")
		expect(
			CH.compileUnsafe(
				base.where(($) => [$.OrgId.eq("a"), $.o.OrgId.eq("b")]),
				{},
			).tenantScope,
		).toBe("cross-tenant")
	})

	it("propagates a bound through tenant-key joins, but not a tautology", () => {
		const joined = CH.from(Events, "e")
			.innerJoin(Other, "o", (e, o) => e.OrgId.eq(o.OrgId))
			.select("Name")
		expect(
			CH.compileUnsafe(
				joined.where(($) => [$.OrgId.eq(CH.param.string("org"))]),
				{ org: "a" },
			).tenantScope,
		).toBe("single-tenant")
		expect(
			CH.compileUnsafe(
				CH.from(Events)
					.select("Name")
					.where(($) => [$.OrgId.eq($.OrgId)]),
				{},
			).tenantScope,
		).toBe("cross-tenant")
		expect(
			CH.compileUnsafe(
				CH.from(Events)
					.select("Name")
					.where(($) => [$.OrgId.in_("a", "b")]),
				{},
			).tenantScope,
		).toBe("cross-tenant")
	})

	it("never scopes the preserved side using only a LEFT JOIN ON constraint", () => {
		const joined = CH.from(Events, "e")
			.leftJoin(Other, "o", (e, o) => e.OrgId.eq(o.OrgId).and(o.OrgId.eq("a")))
			.select("Name")
		expect(CH.compileUnsafe(joined, {}).tenantScope).toBe("cross-tenant")
		expect(
			CH.compileUnsafe(
				joined.where(($) => [$.OrgId.eq("a")]),
				{},
			).tenantScope,
		).toBe("single-tenant")
	})

	it("does not treat a LEFT JOIN's default tenant value as filtering its left side", () => {
		const query = CH.from(Events, "e")
			.leftJoin(Other, "o", (e, o) => e.OrgId.eq(o.OrgId))
			.select("Name")
			.where(($) => [$.o.OrgId.eq("")])
		// join_use_nulls=0 gives an unmatched right String its empty default.
		expect(CH.compileUnsafe(query, {}).tenantScope).toBe("cross-tenant")
	})

	it("does not assign the main tenant column to an untenanted join", () => {
		const dimension = CH.table("dimension", Events.columns)
		const q = CH.from(Events, "e")
			.crossJoin(dimension, "d")
			.select("Name")
			.where(($) => [$.d.OrgId.eq("a")])
		expect(CH.compileUnsafe(q, {}).tenantScope).toBe("cross-tenant")
	})

	it("preserves AND evidence and drops OR evidence", () => {
		const base = CH.from(Events).select("Name")
		expect(
			CH.compileUnsafe(
				base.where(($) => [$.OrgId.eq("a").and($.Id.eq(1))]),
				{},
			).tenantScope,
		).toBe("single-tenant")
		expect(
			CH.compileUnsafe(
				base.where(($) => [$.OrgId.eq("a").or($.Id.eq(1))]),
				{},
			).tenantScope,
		).toBe("cross-tenant")
	})

	it("compares inherited tenant bounds across union branches and joins", () => {
		expect(CH.compileUnionUnsafe(CH.unionAll(branch("a"), branch("b")), {}).tenantScope).toBe(
			"cross-tenant",
		)
		expect(CH.compileUnionUnsafe(CH.unionAll(branch("a"), branch("a")), {}).tenantScope).toBe(
			"single-tenant",
		)
		const joined = CH.fromQuery(branch("a"), "a").crossJoinQuery(branch("b"), "b").select("Name")
		expect(CH.compileUnsafe(joined, {}).tenantScope).toBe("cross-tenant")
	})

	it("does not scope a derived source by filtering a projected tenant alias", () => {
		const projected = CH.from(Events).select(($) => ({ OrgId: CH.lit("a"), Name: $.Name }))
		const facade = CH.table("projected", Events.columns, { tenantColumn: "OrgId" })
		const cte = CH.from(facade)
			.withCTE("projected", projected)
			.select("Name")
			.where(($) => [$.OrgId.eq("a")])
		const sub = CH.fromQuery(projected, "p")
			.select("Name")
			.where(($) => [$.OrgId.eq("a")])
		expect(CH.compileUnsafe(cte, {}).tenantScope).toBe("cross-tenant")
		expect(CH.compileUnsafe(sub, {}).tenantScope).toBe("cross-tenant")
	})

	it("normalizes union branches to the first branch's alias order", () => {
		const a = CH.from(One).select(() => ({ first: CH.lit("a"), last: CH.lit("b") }))
		const b = CH.from(One).select(() => ({ last: CH.lit("d"), first: CH.lit("c") }))
		const compiled = CH.compileUnionUnsafe(CH.unionAll(a, b), {})
		expect(compiled.sql).toMatch(/'c' AS first,\s*'d' AS last/)
		expect(() =>
			CH.compileUnionUnsafe(
				CH.unionAll(a, CH.from(One).select(() => ({ first: CH.lit("c") })) as never),
				{},
			),
		).toThrow("same column aliases")
	})

	it.effect("retains all union branch codecs when selecting from a union", () =>
		Effect.gen(function* () {
			const a = CH.from(One).select(() => ({ value: CH.lit("ok") }))
			const b = CH.from(One).select(() => ({ value: CH.rawExpr("NULL", T.nullable(T.string)) }))
			const compiled = CH.compileUnsafe(CH.fromUnion(CH.unionAll(a, b), "u").select("value"), {})
			expect(yield* compiled.decodeRows([{ value: "ok" }, { value: null }])).toEqual([
				{ value: "ok" },
				{ value: null },
			])
		}),
	)

	it.effect("accepts LEFT JOIN nulls for direct and derived tables", () =>
		Effect.gen(function* () {
			const queries = [
				CH.from(Events)
					.leftJoin(Other, "o", (e, o) => e.Id.eq(o.Id))
					.select(($) => ({ name: $.o.Name })),
				CH.from(Events)
					.leftJoinQuery(CH.from(Other).select("Id", "Name"), "o", (e, o) => e.Id.eq(o.Id))
					.select(($) => ({ name: $.o.Name })),
			]
			for (const query of queries) {
				const compiled = CH.compileUnsafe(query, {})
				expect(yield* compiled.decodeRows([{ name: null }, { name: "" }])).toEqual([
					{ name: null },
					{ name: "" },
				])
				expect(yield* compiled.encodeRows([{ name: null }])).toEqual([{ name: null }])
			}
		}),
	)

	it.effect("decodes empty aggregates and propagates null through numeric expressions", () =>
		Effect.gen(function* () {
			const compiled = CH.compileUnsafe(
				CH.from(One).select(() => ({
					average: CH.avg(CH.lit(1)),
					conditional: CH.avgIf(CH.lit(1), CH.lit(1).eq(0)),
					percentile: CH.quantile(0.95)(CH.lit(1)),
					arithmetic: CH.nullIf(CH.lit(1), 1).add(2).mul(3),
					literalDivisor: CH.lit(3).div(1000000),
				})),
				{},
			)
			const row = {
				average: null,
				conditional: null,
				percentile: null,
				arithmetic: null,
				literalDivisor: 0.000003,
			}
			expect(yield* compiled.decodeRows([row])).toEqual([row])
			// A non-zero literal divisor keeps the codec strict: nan cannot arrive here.
			const exit = yield* Effect.exit(compiled.decodeRows([{ ...row, literalDivisor: null }]))
			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)

	it.effect("uses the conversion result's schema for numeric toDateTime", () =>
		Effect.gen(function* () {
			const compiled = CH.compileUnsafe(
				CH.from(One).select(() => ({ time: CH.toDateTime(CH.lit(1700000000)) })),
				{},
			)
			const rows = yield* compiled.decodeRows([{ time: "2023-11-14 22:13:20" }])
			expect(DateTime.toEpochMillis(rows[0]!.time)).toBe(1700000000000)
		}),
	)

	it("keeps independent parameter codecs with the same SQL type", () => {
		for (let i = 0; i < 3; i++) {
			const q = CH.from(One).select(() => ({ value: CH.param.of(T.array(T.string), "tags") }))
			expect(CH.compileUnsafe(q, { tags: ["a"] }).sql).toContain("['a'] AS value")
		}
		const A = T.custom("String", Schema.Literal("a"))
		const B = T.custom("String", Schema.Literal("b"))
		const query = CH.from(One).select(() => ({ a: CH.param.of(A, "a"), b: CH.param.of(B, "b") }))
		expect(CH.compileUnsafe(query, { a: "a", b: "b" }).sql).toContain("'b' AS b")
		expect(() => CH.compileUnsafe(query, { a: "b", b: "a" })).toThrow("not a valid value")
	})

	it.effect("preserves DateTime64 milliseconds in bounds, params, and encoded rows", () =>
		Effect.gen(function* () {
			const table = CH.table("ticks", { ts: T.dateTime64 })
			const instant = DateTime.makeUnsafe("2026-09-07T00:00:00.789Z")
			for (const bound of [instant, new Date("2026-09-07T00:00:00.789Z")]) {
				expect(
					CH.compileUnsafe(
						CH.from(table)
							.select("ts")
							.where(($) => [$.ts.gte(bound)]),
						{},
					).sql,
				).toContain("'2026-09-07 00:00:00.789'")
			}
			const compiled = CH.compileUnsafe(
				CH.from(table)
					.select("ts")
					.where(($) => [$.ts.gte(CH.param.of(T.dateTime64, "start"))]),
				{ start: instant },
			)
			expect(compiled.sql).toContain("'2026-09-07 00:00:00.789'")
			const wire = [{ ts: "2026-09-07 00:00:00.789" }]
			expect(yield* compiled.encodeRows(yield* compiled.decodeRows(wire))).toEqual(wire)
		}),
	)
})
