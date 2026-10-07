import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { compile, from, param } from "@maple-dev/effect-orm/clickhouse"
import { defineDatasource, engine, t } from "@maple-dev/effect-orm/tinybird"
import { utcDateTime, utcDateTime64 } from "@maple/domain/tinybird/datasources"
import { utcSecondsParam } from "./tables"

const Stamps = defineDatasource("stamps", {
	schema: { OrgId: t.string(), Timestamp: utcDateTime64(9), TimestampTime: utcDateTime() },
	engine: engine.mergeTree({ sortingKey: "OrgId" }),
})

describe("utcSecondsParam", () => {
	it.effect("floors a DateTime.Utc bound for a DateTime column beside a DateTime64 bound", () =>
		Effect.gen(function* () {
			const q = from(Stamps)
				.select(($) => ({ at: $.Timestamp }))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					$.Timestamp.gte(param.dateTime("startTime")),
					$.TimestampTime.gte(utcSecondsParam("startTime")),
				])
			const { sql } = yield* compile(q, {
				orgId: "org_1",
				startTime: DateTime.makeUnsafe(Date.UTC(2026, 9, 7, 10, 0, 0, 123)),
			})
			expect(sql).toContain("Timestamp >= '2026-10-07 10:00:00.123'")
			expect(sql).toContain("TimestampTime >= '2026-10-07 10:00:00'")
		}),
	)
})
