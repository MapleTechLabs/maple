import { describe, expect, it } from "vitest"
import {
	gcpSourceHealth,
	githubInstallationHealth,
	integrationSourceHealth,
	pushSourceHealth,
} from "./source-health"

const HOUR = 3_600_000
const now = 100 * HOUR

describe("pushSourceHealth", () => {
	it.each([
		["active", null, "pending"],
		["active", now - HOUR, "healthy"],
		["active", now - 25 * HOUR, "stale"],
		["paused", now - HOUR, "paused"],
		["expired", now - HOUR, "disconnected"],
	] as const)("%s with last data %s is %s", (status, lastUsedAt, expected) => {
		expect(pushSourceHealth({ status, lastUsedAt }, now).status).toBe(expected)
	})

	it("fails while a refusal is under 15 minutes old, even with data still accepted", () => {
		const refused = { status: "active" as const, lastUsedAt: now - 60_000, lastRejection: "Rate limited" }
		expect(pushSourceHealth({ ...refused, lastRejectedAt: now - 5 * 60_000 }, now)).toEqual({
			status: "failing",
			lastDataAt: now - 60_000,
			problem: "Rate limited",
		})
		expect(pushSourceHealth({ ...refused, lastRejectedAt: now - 20 * 60_000 }, now).status).toBe("healthy")
		expect(pushSourceHealth({ ...refused, status: "paused", lastRejectedAt: now - 60_000 }, now).status).toBe(
			"paused",
		)
	})
})

describe("integrationSourceHealth", () => {
	it("reads the provider status and its newest resource success", () => {
		const health = integrationSourceHealth({
			provider: "railway",
			status: "stale",
			account: null,
			connectedAt: null,
			problem: "1 of 2 stale",
			feeds: [],
			resources: [
				{
					kind: "environment",
					name: "a",
					status: "healthy",
					lastSuccessAt: now - HOUR,
					lastError: null,
					note: null,
				},
				{
					kind: "environment",
					name: "b",
					status: "stale",
					lastSuccessAt: now - 5 * HOUR,
					lastError: null,
					note: null,
				},
			],
		})
		expect(health).toEqual({
			status: "stale",
			lastDataAt: now - HOUR,
			problem: "1 of 2 stale",
			resources: { total: 2, unhealthy: 1 },
		})
	})

	it("is disconnected once the integration is gone", () => {
		expect(integrationSourceHealth(undefined).status).toBe("disconnected")
	})
})

describe("gcpSourceHealth", () => {
	const connector = {
		logsEnabled: true,
		metricsEnabled: true,
		lastReceivedAt: now - HOUR,
		lastError: null,
		lastMetricsReceivedAt: now - 5 * 60_000,
		lastMetricsError: null,
	}

	it("is healthy while both capabilities deliver", () => {
		expect(gcpSourceHealth(connector, now)).toEqual({
			status: "healthy",
			lastDataAt: now - 5 * 60_000,
			problem: null,
		})
	})

	it("fails on a rejected log push", () => {
		expect(gcpSourceHealth({ ...connector, lastError: "bad token" }, now)).toMatchObject({
			status: "failing",
			problem: "bad token",
		})
	})

	it("tolerates a metrics error while reads still land, then fails", () => {
		const erroring = { ...connector, lastMetricsError: "quota" }
		expect(gcpSourceHealth(erroring, now).status).toBe("healthy")
		expect(gcpSourceHealth({ ...erroring, lastMetricsReceivedAt: now - 20 * 60_000 }, now).status).toBe(
			"failing",
		)
	})

	it("is pending before anything arrived and stale once metrics stop", () => {
		const fresh = { ...connector, lastReceivedAt: null, lastMetricsReceivedAt: null }
		expect(gcpSourceHealth(fresh, now).status).toBe("pending")
		expect(gcpSourceHealth({ ...connector, lastMetricsReceivedAt: now - HOUR }, now).status).toBe("stale")
	})
})

describe("githubInstallationHealth", () => {
	const repo = (
		name: string,
		status: "healthy" | "failing" | "pending",
		lastError: string | null = null,
	) => ({
		kind: "repository",
		name,
		status,
		lastSuccessAt: status === "healthy" ? now - HOUR : null,
		lastError,
		note: null,
	})
	const entry = {
		provider: "github" as const,
		status: "failing" as const,
		account: "acme, globex",
		connectedAt: null,
		problem: "1 of 3 failing",
		feeds: [],
		resources: [
			repo("acme/api", "healthy"),
			repo("Globex/web", "failing", "sync denied"),
			repo("acme/app", "healthy"),
		],
	}

	it("scores each installation by its own repositories", () => {
		expect(githubInstallationHealth(entry, "acme")).toEqual({
			status: "healthy",
			lastDataAt: now - HOUR,
			problem: null,
			resources: { total: 2, unhealthy: 0 },
		})
		expect(githubInstallationHealth(entry, "globex")).toEqual({
			status: "failing",
			lastDataAt: null,
			problem: "Globex/web: sync denied",
		})
	})

	it("is pending before any repository synced and disconnected once GitHub is gone", () => {
		expect(githubInstallationHealth(entry, "initech").status).toBe("pending")
		expect(githubInstallationHealth(undefined, "acme").status).toBe("disconnected")
	})
})
