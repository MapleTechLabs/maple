import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect } from "effect"
import { auditArchiveLocks, auditArchiveRetentionDays } from "./audit-events.ts"

const readDays = (env: Record<string, string>) =>
	Effect.runSync(auditArchiveRetentionDays.parse(ConfigProvider.fromUnknown(env)))

describe("audit archive retention", () => {
	it("defaults to 365 days and can be configured", () => {
		expect([readDays({}), readDays({ MAPLE_AUDIT_ARCHIVE_RETENTION_DAYS: "730" })]).toEqual([365, 730])
	})

	it("locks every archived object on prd for the retention period", () => {
		expect(auditArchiveLocks({ kind: "prd" }, 365)).toEqual([
			{
				id: "audit-write-once",
				enabled: true,
				prefix: "audit/",
				condition: { type: "Age", maxAgeSeconds: 365 * 86_400 },
			},
		])
	})

	it("leaves preview and dev buckets unlocked so their stages can be torn down", () => {
		expect([
			auditArchiveLocks({ kind: "pr", prNumber: 1 }, 365),
			auditArchiveLocks({ kind: "dev", name: "dev" }, 365),
		]).toEqual([[], []])
	})
})
