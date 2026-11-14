import { assert, describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Array as Arr } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { compile, from, param } from "@maple-dev/effect-orm/clickhouse"
import { defineDatasource, engine, t } from "@maple-dev/effect-orm/tinybird"
import { OrgId } from "@maple/domain"
import { orgIdParam, utcSecondsParam } from "./tables"
import * as Datasources from "@maple/domain/tinybird/datasources"

const Stamps = defineDatasource("stamps", {
	schema: {
		OrgId: t.string(),
		Timestamp: Datasources.utcDateTime64(9),
		TimestampTime: Datasources.utcDateTime(),
	},
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

	it.effect("floors a fractional string bound", () =>
		Effect.gen(function* () {
			const q = from(Stamps)
				.select(($) => ({ at: $.Timestamp }))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					$.Timestamp.gte(param.dateTime("startTime")),
					$.TimestampTime.gte(utcSecondsParam("startTime")),
				])
			const { sql } = yield* compile(q, { orgId: "org_1", startTime: "2026-10-07 10:00:00.123" })
			expect(sql).toContain("Timestamp >= '2026-10-07 10:00:00.123'")
			expect(sql).toContain("TimestampTime >= '2026-10-07 10:00:00'")
		}),
	)
})

describe("wrapped utcDateTime64 columns", () => {
	it.effect("an Array(DateTime64) column decodes each element to DateTime.Utc", () =>
		Effect.gen(function* () {
			const q = from(Datasources.metricsSum)
				.select(($) => ({ exemplars: $.ExemplarsTimestamp }))
				.where(($) => [$.OrgId.eq(orgIdParam)])
			const compiled = yield* compile(q, { orgId: OrgId.make("org_1") })
			expect(compiled.rowSchemaSource).toBe("derived")
			const [row] = yield* compiled.decodeRows([
				{ exemplars: ["2026-10-07 10:00:00.123456789", "2026-10-07 10:00:01.000000000"] },
			])
			assert.isDefined(row)
			expect(Arr.map(row.exemplars, DateTime.formatIso)).toEqual([
				"2026-10-07T10:00:00.123Z",
				"2026-10-07T10:00:01.000Z",
			])
		}),
	)

	it.effect("a SimpleAggregateFunction(min, DateTime64) column decodes to DateTime.Utc", () =>
		Effect.gen(function* () {
			const q = from(Datasources.identityLinks)
				.select(($) => ({ firstSeen: $.FirstSeen, earliest: CH.min_($.FirstSeen) }))
				.where(($) => [$.OrgId.eq(orgIdParam)])
				.groupBy("firstSeen")
			const compiled = yield* compile(q, { orgId: OrgId.make("org_1") })
			expect(compiled.rowSchemaSource).toBe("derived")
			const [row] = yield* compiled.decodeRows([
				{ firstSeen: "2026-10-07 10:00:00.250000000", earliest: "2026-10-07 09:00:00.000000000" },
			])
			assert.isDefined(row)
			expect(DateTime.formatIso(row.firstSeen)).toBe("2026-10-07T10:00:00.250Z")
			expect(DateTime.formatIso(row.earliest)).toBe("2026-10-07T09:00:00.000Z")
		}),
	)
})
