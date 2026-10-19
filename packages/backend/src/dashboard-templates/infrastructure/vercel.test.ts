import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
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
	vercelTemplate
		.build(params)
		.widgets.flatMap((widget) =>
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
				if (sql.includes("FROM logs")) {
					expect(prepared.sql, id).toContain("ServiceName = 'it\\'s-mine'")
				} else {
					expect(prepared.sql, id).not.toContain("it\\'s-mine")
				}
			}
		}),
	)
})
