import { describe, expect, it } from "vitest"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { OrgId, UserId } from "@maple/primitives"
import { Schema, Array as Arr } from "effect"
import { AuditLogEvent } from "@maple/backend/services/audit/audit-event"
import { mapleAuditTrailEvents } from "./maple"

const ORG = Schema.decodeSync(OrgId)("org_trail_maple")
const USER = Schema.decodeSync(UserId)("user_trail_maple")
const KEY_ID = "5b8f2c1e-7a55-4c0e-9a3b-0d2c7e5b9a11"

const entry = (overrides: Partial<ConstructorParameters<typeof AuditLogEvent>[0]> = {}) =>
	new AuditLogEvent({
		orgId: ORG,
		id: Schema.decodeSync(AuditLogEvent.fields.id)("9d2c1e3a-6a1b-4f0e-9c1d-2b3a4c5d6e7f"),
		actorType: "user",
		userId: USER,
		source: "dashboard",
		action: "alert_rule.updated",
		outcome: "allowed",
		occurredAtMs: 1_700_000_000_000,
		...overrides,
	})

const ALERT_RULE = { resourceType: "alert_rule", resourceId: "alrt_1" }

/** The trail event for one audit entry, or undefined when the trail leaves it out. */
const trailEventOf = (overrides: Parameters<typeof entry>[0] = {}) =>
	mapleAuditTrailEvents([entry(overrides)])[0]

describe("mapleAuditTrailEvents", () => {
	it("carries a change with its actor, target and diff", () => {
		const changes = { fields: ["name"], before: { name: "a" }, after: { name: "b" } }
		const event = trailEventOf({ ...ALERT_RULE, changes, originIp: "203.0.113.7", originCountry: "DE" })

		expect(event).toMatchObject({
			provider: "maple",
			actor: { type: "user", id: USER },
			action: "alert_rule.updated",
			category: "configuration",
			outcome: "success",
			target: { type: "alert_rule", id: "alrt_1" },
			originIp: "203.0.113.7",
			originCountry: "DE",
			raw: { source: "dashboard", changes },
		})
	})

	it("leaves an allowed read out and keeps a refused one", () => {
		const read = { action: "telemetry.read", resourceType: "telemetry" }

		expect(trailEventOf({ ...read, outcome: "allowed" })).toBeUndefined()
		expect(trailEventOf({ ...read, outcome: "denied", denialReason: "missing scope" })).toMatchObject({
			category: "data_access",
			outcome: "denied",
			raw: { denialReason: "missing scope" },
		})
	})

	it("names an API key by its public id and the name it had, not by the person who minted it", () => {
		const event = trailEventOf({
			actorType: "api_key",
			apiKeyId: Schema.decodeSync(AuditLogEvent.fields.apiKeyId)(KEY_ID),
			actorLabel: "CI deploy key",
		})

		expect(event?.actor).toEqual({
			type: "service",
			id: encodePublicId(PublicIdPrefixes.apiKey, KEY_ID),
			name: "CI deploy key",
		})
	})

	it("points a membership change at the member it happened to", () => {
		const event = trailEventOf({
			actorType: "system",
			source: "system",
			action: "member.removed",
			resourceType: "member",
			affectedUserId: USER,
		})

		expect(event).toMatchObject({
			category: "membership",
			actor: { type: "system" },
			target: { type: "member", id: USER },
		})
	})

	it("files a secret set or removed on a non-credential resource under credential", () => {
		const categoryOf = (action: string) => trailEventOf({ action, resourceType: "status_page" })?.category

		expect(
			Arr.map(
				[
					"status_page.break_glass_rotated",
					"status_page.break_glass_revoked",
					"status_page.password_set",
					"status_page.password_removed",
				],
				categoryOf,
			),
		).toEqual(["credential", "credential", "credential", "credential"])
		expect(categoryOf("status_page.updated")).toBe("resource")
	})

	it("files linking and unlinking a chat identity under permission", () => {
		const categoryOf = (action: string) =>
			trailEventOf({ action, resourceType: "chat_integration" })?.category

		expect(
			Arr.map(
				["chat_integration.identity_link_started", "chat_integration.identity_unlinked"],
				categoryOf,
			),
		).toEqual(["permission", "permission"])
		expect(categoryOf("chat_integration.settings_updated")).toBe("configuration")
	})

	it("files a resource this build does not know under other", () => {
		expect(trailEventOf({ action: "hologram.created", resourceType: "hologram" })?.category).toBe("other")
	})

	it("keeps the kept entries in order and drops the rest", () => {
		const events = mapleAuditTrailEvents([
			entry(ALERT_RULE),
			entry({ action: "telemetry.read", resourceType: "telemetry" }),
			entry({ action: "dashboard.created", resourceType: "dashboard" }),
		])

		expect(Arr.map(events, (event) => event.action)).toEqual(["alert_rule.updated", "dashboard.created"])
	})
})
