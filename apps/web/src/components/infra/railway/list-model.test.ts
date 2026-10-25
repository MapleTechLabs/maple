import { describe, expect, it } from "vitest"
import { RailwayEnvironmentStatus } from "@maple/domain/http"

import type { RailwayServiceRow } from "@maple/web-data/warehouse/railway-infra"

import { fleetSync, groupRailwayServices, hasConfiguredLimits } from "./list-model"

const GIB = 1024 ** 3

const service = (
	serviceName: string,
	environmentId: string,
	memoryAvg: number,
	limits: { cpu: number; memory: number } = { cpu: 32, memory: 32 * GIB },
): RailwayServiceRow => ({
	environmentId,
	serviceId: serviceName,
	serviceName,
	projectName: environmentId === "env-maple" ? "maple" : "hazel",
	environmentName: "production",
	cpuAvg: 0.01,
	cpuMax: 0.2,
	cpuLimit: limits.cpu,
	memoryAvg,
	memoryMax: memoryAvg * 1.1,
	memoryLimit: limits.memory,
	replicas: 1,
	lastSeen: "2026-10-14T23:00:00Z",
})

const environment = (
	environmentId: string,
	patch: Partial<{ lastSyncedAt: number | null; lastError: string | null }> = {},
) =>
	new RailwayEnvironmentStatus({
		projectId: `p-${environmentId}`,
		projectName: environmentId === "env-maple" ? "maple" : "hazel",
		environmentId,
		environmentName: "production",
		serviceCount: 1,
		enabled: true,
		lastSyncedAt: 1_000,
		lastError: null,
		...patch,
	})

describe("groupRailwayServices", () => {
	it("puts each environment's services together, heaviest environment first", () => {
		const groups = groupRailwayServices(
			[
				service("prometheus-scraper", "env-maple", 265e6),
				service("api", "env-hazel", 442e6),
				service("electric", "env-hazel", 505e6),
			],
			[environment("env-hazel"), environment("env-maple")],
			false,
		)
		expect(
			groups.map((group) => [group.projectName, group.services.map((row) => row.serviceName)]),
		).toEqual([
			["hazel", ["api", "electric"]],
			["maple", ["prometheus-scraper"]],
		])
		expect(groups[0]?.memoryAvg).toBe(947e6)
	})

	it("reads each group's sync from its own environment's status", () => {
		const groups = groupRailwayServices(
			[
				service("api", "env-hazel", 2),
				service("scraper", "env-maple", 1),
				service("orphan", "env-gone", 0),
			],
			[
				environment("env-hazel", { lastError: "429 Too Many Requests", lastSyncedAt: 500 }),
				environment("env-maple"),
			],
			false,
		)
		expect(groups.map((group) => group.sync)).toEqual([
			{ kind: "failing", error: "429 Too Many Requests", lastSyncedAt: 500 },
			{ kind: "synced", at: 1_000 },
			{ kind: "unknown" },
		])
	})

	it("pauses every group when the token is rejected, instead of blaming one", () => {
		const [group] = groupRailwayServices(
			[service("api", "env-hazel", 1)],
			[environment("env-hazel")],
			true,
		)
		expect(group?.sync).toEqual({ kind: "paused", lastSyncedAt: 1_000 })
	})
})

describe("hasConfiguredLimits", () => {
	it("is false when every service sits at the same plan ceiling", () => {
		expect(hasConfiguredLimits([service("api", "e", 1), service("electric", "e", 1)])).toBe(false)
	})

	it("is true once one service has a limit of its own", () => {
		expect(
			hasConfiguredLimits([
				service("api", "e", 1),
				service("worker", "e", 1, { cpu: 2, memory: 32 * GIB }),
			]),
		).toBe(true)
	})
})

describe("fleetSync", () => {
	it("counts failing and first-sync environments and keeps the newest sync time", () => {
		expect(
			fleetSync(
				[
					environment("a", { lastSyncedAt: 2_000 }),
					environment("b", { lastError: "boom" }),
					environment("c", { lastSyncedAt: null }),
				],
				false,
			),
		).toEqual({ failing: 1, pending: 1, lastSyncedAt: 2_000 })
	})
})
