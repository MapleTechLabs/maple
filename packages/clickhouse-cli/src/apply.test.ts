import { describe, expect, it, vi } from "vitest"
import { expandMigrationToSteps, migrations } from "@maple/domain/clickhouse"
import { applyMigrationSteps, applySchemaFeatures, reconcileSchemaFeatures } from "./apply"

describe("applySchemaFeatures", () => {
	it("skips unsupported features without executing or recording them", async () => {
		const executed: string[] = []
		const recorded: string[] = []
		const result = await applySchemaFeatures({
			serverVersion: "24.8.12",
			appliedFeatureRevisions: new Map(),
			execute: async (sql) => {
				executed.push(sql)
				return ""
			},
			record: async (feature) => {
				recorded.push(feature.id)
			},
		})

		expect(executed).toEqual([])
		expect(recorded).toEqual([])
		expect(result.skippedFeatures[0]?.reason).toContain("requires ClickHouse 26.2.0+")
	})

	it("skips a feature whose revision is already recorded", async () => {
		const executed: string[] = []
		const recorded: string[] = []
		const result = await applySchemaFeatures({
			serverVersion: "26.2.1",
			appliedFeatureRevisions: new Map([["search_text_v1", 1]]),
			execute: async (sql) => {
				executed.push(sql)
				return ""
			},
			record: async (feature) => {
				recorded.push(feature.id)
			},
		})

		expect(executed).toEqual([])
		expect(recorded).toEqual([])
		expect(result.skippedFeatures[0]?.reason).toBe("already present")
	})

	it("does not record a partially applied feature and reports the failure", async () => {
		const executed: string[] = []
		const recorded: string[] = []
		const result = await applySchemaFeatures({
			serverVersion: "26.2.1",
			appliedFeatureRevisions: new Map(),
			execute: async (sql) => {
				executed.push(sql)
				if (executed.length === 2) throw new Error("DDL rejected")
				return ""
			},
			record: async (feature) => {
				recorded.push(feature.id)
			},
		})

		expect(executed).toHaveLength(2)
		expect(recorded).toEqual([])
		expect(result.appliedFeatures).toEqual([])
		expect(result.skippedFeatures[0]?.reason).toBe("DDL rejected")
	})

	it("records only after every statement succeeds", async () => {
		const events: string[] = []
		const result = await applySchemaFeatures({
			serverVersion: "26.2.1",
			appliedFeatureRevisions: new Map(),
			execute: async (sql) => {
				events.push(`execute:${sql}`)
				return ""
			},
			record: async (feature) => {
				events.push(`record:${feature.id}`)
			},
		})

		expect(result.appliedFeatures.map((feature) => feature.id)).toEqual(["search_text_v1"])
		expect(result.skippedFeatures).toEqual([])
		expect(events.at(-1)).toBe("record:search_text_v1")
		expect(events.slice(0, -1).every((event) => event.startsWith("execute:"))).toBe(true)
		expect(events.some((event) => event.includes("MATERIALIZE"))).toBe(false)
	})
})

describe("reconcileSchemaFeatures", () => {
	const optionalAdapters = {
		readServerVersion: async () => "26.2.1",
		readAppliedFeatureRevisions: async () => new Map<string, number>(),
		execute: async () => "",
		record: async () => {},
	}

	it("reports feature bookkeeping creation failures without rejecting", async () => {
		const result = await reconcileSchemaFeatures({
			...optionalAdapters,
			ensureBookkeeping: async () => {
				throw new Error("CREATE TABLE denied")
			},
		})

		expect(result.appliedFeatures).toEqual([])
		expect(result.skippedFeatures).toEqual([
			{
				id: "feature_reconciliation",
				description: "Reconcile optional schema features",
				reason: "CREATE TABLE denied",
			},
		])
	})

	it("reports feature bookkeeping read failures without rejecting", async () => {
		const result = await reconcileSchemaFeatures({
			...optionalAdapters,
			ensureBookkeeping: async () => {},
			readAppliedFeatureRevisions: async () => {
				throw new Error("SELECT denied")
			},
		})

		expect(result.appliedFeatures).toEqual([])
		expect(result.skippedFeatures[0]?.reason).toBe("SELECT denied")
	})
})

describe("applyMigrationSteps", () => {
	const retentionStorage = migrations.find((migration) => migration.version === 77)

	/** A cluster that rejects `failing`, and answers the DEFAULT read-back with `defaultNow`. */
	const cluster = (failing: string, defaultNow: string) => {
		const executed: string[] = []
		const execute = async (sql: string) => {
			executed.push(sql)
			if (sql.startsWith(failing)) throw new Error("BAD_ARGUMENTS")
			return sql.startsWith("SELECT default_expression")
				? `{"default_expression":"${defaultNow}"}\n`
				: ""
		}
		return { executed, execute }
	}

	it("restores the DEFAULT, then restarts merges, when 0077's key ALTER fails; the ALTER's error stands", async () => {
		if (retentionStorage === undefined) throw new Error("migration 77 is not bundled")
		const steps = await expandMigrationToSteps(retentionStorage, "maple", async () => "")
		const { executed, execute } = cluster("ALTER TABLE trace_index ADD COLUMN", "30")

		await expect(applyMigrationSteps(steps, execute)).rejects.toThrow(/^BAD_ARGUMENTS$/)
		expect(executed.slice(-4)).toEqual([
			"ALTER TABLE trace_index ADD COLUMN IF NOT EXISTS RetentionDays UInt16, MODIFY ORDER BY (OrgId, TraceId, ServiceName, Bucket, RetentionDays)",
			"ALTER TABLE trace_index MODIFY COLUMN RetentionDays UInt16 DEFAULT 30",
			"SELECT default_expression FROM system.columns WHERE database = 'maple' AND table = 'trace_index' AND name = 'RetentionDays' FORMAT JSONEachRow",
			"SYSTEM START MERGES trace_index",
		])
	})

	it("leaves merges stopped when the DEFAULT cannot be restored, and says what to run", async () => {
		if (retentionStorage === undefined) throw new Error("migration 77 is not bundled")
		const steps = await expandMigrationToSteps(retentionStorage, "maple", async () => "")
		const { executed, execute } = cluster("ALTER TABLE trace_index MODIFY COLUMN", "")

		const failure = applyMigrationSteps(steps, execute)
		await expect(failure).rejects.toThrow(/^BAD_ARGUMENTS\n/)
		await expect(failure).rejects.toThrow(
			"Run `ALTER TABLE trace_index MODIFY COLUMN RetentionDays UInt16 DEFAULT 30`, then `SYSTEM START MERGES trace_index`.",
		)
		expect(executed).not.toContain("SYSTEM START MERGES trace_index")
	})

	it("keeps the step's error when the restart fails too, and reports the failed restart", async () => {
		const warnings = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const failure = applyMigrationSteps(
			[{ name: "alter", sql: "ALTER", backfill: false, onFailure: "SYSTEM START MERGES t" }],
			async (sql) => {
				throw new Error(sql === "ALTER" ? "ALTER rejected" : "START rejected")
			},
		)
		await expect(failure).rejects.toThrow("ALTER rejected")
		expect(warnings).toHaveBeenCalledWith(expect.stringContaining("SYSTEM START MERGES t"))
		expect(warnings).toHaveBeenCalledWith(expect.stringContaining("START rejected"))
		warnings.mockRestore()
	})

	it("restarts nothing when a step outside a stopped pair fails", async () => {
		const executed: string[] = []
		const failure = applyMigrationSteps(
			[{ name: "alter", sql: "ALTER", backfill: false }],
			async (sql) => {
				executed.push(sql)
				throw new Error("ALTER rejected")
			},
		)
		await expect(failure).rejects.toThrow("ALTER rejected")
		expect(executed).toEqual(["ALTER"])
	})
})
