import { describe, expect, it } from "vitest"
import type { V2ApiKey } from "@maple/domain/http/v2"
import { apiKeyStatus } from "./api-keys-section"

const NOW = Date.parse("2026-09-11T12:00:00Z")
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString()

const key = (overrides: Partial<V2ApiKey>): V2ApiKey =>
	({
		id: "ak_1",
		name: "CI",
		description: null,
		key_prefix: "maple_ak_abc",
		kind: "standard",
		scopes: null,
		revoked: false,
		expires_at: null,
		last_used_at: null,
		created_at: inDays(-30),
		created_by_email: null,
		...overrides,
	}) as V2ApiKey

describe("apiKeyStatus", () => {
	it("is active when it never expires", () => {
		expect(apiKeyStatus(key({ expires_at: null }), NOW)).toBe("active")
	})

	it("is active while the expiry is more than a week out", () => {
		expect(apiKeyStatus(key({ expires_at: inDays(8) }), NOW)).toBe("active")
	})

	it("is expiring inside the last week", () => {
		expect(apiKeyStatus(key({ expires_at: inDays(6) }), NOW)).toBe("expiring")
		expect(apiKeyStatus(key({ expires_at: inDays(0.5) }), NOW)).toBe("expiring")
	})

	it("is expired once the moment passes", () => {
		expect(apiKeyStatus(key({ expires_at: inDays(-0.1) }), NOW)).toBe("expired")
	})

	it("counts an expiry exactly at now as expired, not expiring", () => {
		expect(apiKeyStatus(key({ expires_at: new Date(NOW).toISOString() }), NOW)).toBe("expired")
	})

	it("lets revoked win over every expiry state", () => {
		expect(apiKeyStatus(key({ revoked: true, expires_at: inDays(30) }), NOW)).toBe("revoked")
		expect(apiKeyStatus(key({ revoked: true, expires_at: inDays(-30) }), NOW)).toBe("revoked")
	})

	it("treats an unparseable expiry as active rather than expired", () => {
		// A key that still works must never be filed under "Expired" because a timestamp was odd.
		expect(apiKeyStatus(key({ expires_at: "not-a-date" }), NOW)).toBe("active")
	})
})
