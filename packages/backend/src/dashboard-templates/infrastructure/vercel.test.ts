import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, String as Str } from "effect"
import { OrgId } from "@maple/domain"
import { prepareRawSql } from "@maple/query-engine/runtime"
import { vercelTemplate } from "./vercel"

const prepare = (sql: string) =>
	prepareRawSql({
		sql,
		orgId: OrgId.make("org_abc"),
		startTime: "2026-10-19 00:00:00",
		endTime: "2026-10-19 06:00:00",
		granularitySeconds: 300,
		workload: "interactive",
	})

const rawSqlOf = (params: Parameters<typeof vercelTemplate.build>[0]) =>
	Arr.flatMap(vercelTemplate.build(params).widgets, (widget) =>
		widget.dataSource.kind === "raw_sql" ? [{ id: widget.id, sql: widget.dataSource.sql }] : [],
	)

describe("Vercel dashboard template", () => {
	it.effect("runs every SQL widget through the raw-SQL validator, scoped to the org", () =>
		Effect.gen(function* () {
			const widgets = rawSqlOf({})
			expect(widgets.length).toBeGreaterThan(0)
			for (const { id, sql } of widgets) {
				const prepared = yield* prepare(sql)
				expect(prepared.sql, id).toContain("(OrgId = 'org_abc')")
				expect(prepared.sql, id).not.toContain("$__")
			}
		}),
	)

	it.effect("scopes the log widgets to the chosen project without letting its name end the literal", () =>
		Effect.gen(function* () {
			for (const { id, sql } of rawSqlOf({ project_name: "it's-mine" })) {
				const prepared = yield* prepare(sql)
				// AI Gateway spans carry the project id, not its name, so only log widgets narrow.
				if (Str.includes("FROM logs")(sql)) {
					expect(prepared.sql, id).toContain("ServiceName = 'it\\'s-mine'")
				} else {
					expect(prepared.sql, id).not.toContain("it\\'s-mine")
				}
			}
		}),
	)

	it("counts AI Gateway requests by server span, spends only USD and names models by response first", () => {
		const gateway = Arr.filter(rawSqlOf({}), ({ sql }) => Str.includes("FROM traces")(sql))
		expect(Arr.map(gateway, ({ id }) => id)).toContain("kpi-gateway-requests")
		for (const { id, sql } of gateway) {
			expect(sql, id).toContain("SpanKind = 'Server'")
			expect(sql, id).not.toContain("ParentSpanId")
			if (Str.includes("cost.total")(sql)) {
				expect(sql, id).toContain("SpanAttributes['vercel.ai_gateway.cost.currency'] IN ('', 'USD')")
			}
			if (Str.includes("gen_ai.request.model")(sql)) {
				expect(sql, id).toContain(
					"if(SpanAttributes['gen_ai.response.model'] != '', SpanAttributes['gen_ai.response.model'], SpanAttributes['gen_ai.request.model'])",
				)
			}
		}
		// Every gateway widget is SQL: the traces builder can filter neither kind nor fall back between models.
		const builderTraces = Arr.filter(
			vercelTemplate.build({}).widgets,
			(widget) =>
				widget.dataSource.kind !== "raw_sql" &&
				Str.includes("traces")(JSON.stringify(widget.dataSource)),
		)
		expect(builderTraces).toEqual([])
	})
})
