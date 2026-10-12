import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { compile } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { auditLogEntriesQuery } from "./audit-log"

describe("auditLogEntriesQuery", () => {
	it.effect("bounds OccurredAt with DateTime.Utc and decodes both timestamps", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(
				auditLogEntriesQuery({ since: true, until: true, limit: 10, offset: 0 }),
				{
					orgId: OrgId.make("org_1"),
					since: DateTime.makeUnsafe("2026-10-01T00:00:00.250Z"),
					until: DateTime.makeUnsafe("2026-10-02T00:00:00Z"),
				},
			)
			expect(compiled.sql).toContain("OccurredAt >= '2026-10-01 00:00:00.250'")
			expect(compiled.sql).toContain("OccurredAt <= '2026-10-02 00:00:00'")
			expect(compiled.rowSchemaSource).toBe("derived")

			const [row] = yield* compiled.decodeRows([
				{
					id: "entry_1",
					occurredAt: "2026-10-01 10:00:00.041",
					recordedAt: "2026-10-01 10:00:01.500",
					actorType: "user",
					userId: "user_1",
					apiKeyId: "",
					actorId: "",
					actorLabel: "",
					affectedUserId: "",
					source: "api",
					action: "dashboard.update",
					outcome: "allowed",
					denialReason: "",
					resourceType: "dashboard",
					resourceId: "d1",
					changedFields: [],
					changes: "",
					metadata: "",
					requestId: "",
					originIp: "",
					originCountry: "",
				},
			])
			expect(DateTime.formatIso(row!.occurredAt)).toBe("2026-10-01T10:00:00.041Z")
			expect(DateTime.formatIso(row!.recordedAt)).toBe("2026-10-01T10:00:01.500Z")
		}),
	)
})
