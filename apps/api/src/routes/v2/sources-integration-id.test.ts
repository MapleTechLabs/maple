import { describe, expect, it } from "@effect/vitest"
import { Source } from "@maple/domain/http"
import { Schema } from "effect"
import { integrationIdOf } from "./sources.http"

const UUID = "0199a0e1-0000-7000-8000-0000000000aa"

const source = (platform: string, integrationId: string | null) =>
	Schema.decodeUnknownSync(Source)({
		id: "0199a0e1-0000-7000-8000-000000000001",
		name: "s",
		description: null,
		platform,
		kind: integrationId === null ? "token" : "integration",
		keyPrefix: null,
		integrationId,
		status: "active",
		allowedSignals: null,
		rateLimitRps: null,
		resourceAttributes: [],
		expiresAt: null,
		pausedAt: null,
		pausedUntil: null,
		lastUsedAt: null,
		rolledAt: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		health: { status: "healthy", lastDataAt: null, problem: null, resources: null },
	})

describe("integration_id", () => {
	it("is the public id for scrape targets and Google Cloud connectors, the raw id otherwise", () => {
		expect(integrationIdOf(source("prometheus", UUID))).toMatch(/^scrp_/)
		expect(integrationIdOf(source("gcp", UUID))).toMatch(/^gcpc_/)
		expect(integrationIdOf(source("railway", UUID))).toBe(UUID)
		expect(integrationIdOf(source("nodejs", null))).toBeNull()
	})
})
