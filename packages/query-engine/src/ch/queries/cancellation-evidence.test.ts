import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { compile, compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	cancellationAlertChecksQuery,
	cancellationAuditActionsQuery,
	cancellationAuditActorsQuery,
	cancellationProductEventsQuery,
	cancellationResourceAttributesQuery,
	cancellationServiceUsageQuery,
	cancellationToolCallsQuery,
} from "./cancellation-evidence"

const window = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-08-21 15:30:00",
	splitTime: "2026-09-20 15:30:00",
	endTime: "2026-10-20 15:30:00",
}

describe("cancellationServiceUsageQuery", () => {
	it.effect("splits each service's bytes at the window's midpoint and decodes UInt64s from strings", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(cancellationServiceUsageQuery({ limit: 15 }), window)
			expect(compiled.sql).toContain("service_usage.OrgId = 'org_1'")
			expect(compiled.sql).toMatch(
				/sumIf\(service_usage\.TraceSizeBytes, service_usage\.Hour >= toStartOfHour\(toDateTime\('2026-09-20 15:30:00'\)\)\) AS recentTraceBytes/,
			)
			expect(compiled.sql).toMatch(
				/sumIf\(service_usage\.TraceSizeBytes, service_usage\.Hour < toStartOfHour\(toDateTime\('2026-09-20 15:30:00'\)\)\) AS priorTraceBytes/,
			)
			expect(compiled.sql).toMatch(/ORDER BY totalBytes DESC, serviceName ASC\s+LIMIT 15/)

			const [row] = yield* compiled.decodeRows([
				{
					serviceName: "api",
					recentTraceBytes: "18446744073",
					recentLogBytes: "0",
					recentMetricBytes: "0",
					priorTraceBytes: "0",
					priorLogBytes: "0",
					priorMetricBytes: "0",
					totalBytes: "18446744073",
					firstHour: "2026-08-21 16:00:00",
					lastHour: "2026-10-20 15:00:00",
					activeDaysRecent: "30",
					activeDaysPrior: "0",
				},
			])
			expect(row!.recentTraceBytes).toBe(18_446_744_073)
			expect(DateTime.formatIso(row!.lastHour)).toBe("2026-10-20T15:00:00.000Z")
		}),
	)
})

describe("cancellationResourceAttributesQuery", () => {
	it("reads the five resource keys from the resource scope, grouped by their raw values", () => {
		const { sql } = compileUnsafe(cancellationResourceAttributesQuery({ limit: 500 }), window)
		expect(sql).toContain("AttributeScope = 'resource'")
		expect(sql).toMatch(/AttributeKey IN \('deployment\.environment', [^)]*'telemetry\.sdk\.version'\)/)
		expect(sql).not.toContain("service.name")
		expect(sql).not.toContain("if(")
	})
})

describe("cancellationAlertChecksQuery", () => {
	it("reads the managed warehouse, where the alerting worker writes checks", () => {
		const compiled = compileUnsafe(cancellationAlertChecksQuery(), window)
		expect(compiled.route).toBe("ingest")
		expect(compiled.sql).toContain("GROUP BY status, skipReason, errorCategory")
	})
})

describe("cancellationProductEventsQuery", () => {
	it("reads the group's custom and server events, never page views", () => {
		const { sql } = compileUnsafe(cancellationProductEventsQuery({ limit: 50 }), {
			...window,
			groupId: "org_customer",
		})
		expect(sql).toContain("product_events.GroupId = 'org_customer'")
		expect(sql).toContain("product_events.Kind = 'custom'")
		expect(sql).toContain("GROUP BY eventName, source")
	})
})

describe("cancellationAuditActionsQuery", () => {
	it("counts every action of the org's own actors, reads included, from the managed warehouse", () => {
		const compiled = compileUnsafe(cancellationAuditActionsQuery({ limit: 25 }), window)
		expect(compiled.route).toBe("ingest")
		expect(compiled.sql).not.toContain("Action =")
		expect(compiled.sql).toContain("audit_log.ActorType != 'system'")
		expect(compiled.sql).toContain("countIf(audit_log.Outcome != 'allowed') AS denied")
	})
})

describe("cancellationAuditActorsQuery", () => {
	it("counts every entry, Maple's own included, per actor type", () => {
		const compiled = compileUnsafe(cancellationAuditActorsQuery(), window)
		expect(compiled.route).toBe("ingest")
		expect(compiled.sql).not.toContain("ActorType !=")
		expect(compiled.sql).toContain("GROUP BY actorType")
	})
})

describe("cancellationToolCallsQuery", () => {
	it("breaks tool calls down by the tool and surface in their metadata", () => {
		const compiled = compileUnsafe(cancellationToolCallsQuery({ limit: 15 }), window)
		expect(compiled.sql).toContain("audit_log.Action = 'mcp_tool.called'")
		expect(compiled.sql).toContain("audit_log.ActorType != 'system'")
		expect(compiled.sql).toContain("JSONExtractString(audit_log.Metadata, 'tool') AS tool")
		expect(compiled.sql).toContain("countIf(JSONExtractBool(audit_log.Metadata, 'is_error')) AS errors")
		expect(compiled.rowSchemaSource).toBe("derived")
	})
})
