import { describe, expect, it } from "vitest"
import { Option, String as Str } from "effect"
import { deliveryTimeMs, githubAuditEvent } from "../github-audit-events"

const RECEIVED_AT = 1_763_000_000_000

const sender = { login: "octocat", id: 1, type: "User" }
const organization = { login: "acme", id: 500 }
const repository = { id: 7, full_name: "acme/api", owner: { login: "acme" } }

const map = (event: string, payload: unknown, deliveryId: string | undefined) =>
	githubAuditEvent({ event, deliveryId, payload, receivedAtMs: RECEIVED_AT })

const mapped = (event: string, payload: unknown) => {
	const result = map(event, payload, "delivery-1")
	if (Option.isNone(result)) throw new Error(`${event} was not mapped`)
	return result.value
}

describe("githubAuditEvent", () => {
	it("records who added a member to the organization, keyed by the delivery", () => {
		const event = mapped("organization", {
			action: "member_added",
			membership: { user: { login: "newhire", id: 22 }, role: "member" },
			organization,
			sender,
			installation: { id: 42, account: { login: "acme" } },
		})
		expect(event).toMatchObject({
			provider: "github",
			providerEventId: "delivery-1",
			account: "acme",
			occurredAtMs: RECEIVED_AT,
			actor: { type: "user", id: "1", name: "octocat" },
			action: "organization.member_added",
			category: "membership",
			outcome: "success",
			target: { type: "user", id: "22", name: "newhire" },
		})
		// The installation block is Maple's own app, the same on every delivery.
		expect(event.raw).not.toHaveProperty("installation")
		expect(event.raw).toHaveProperty("membership")
	})

	it("names an invited person by login, or by email when they have no account yet", () => {
		const byEmail = mapped("organization", {
			action: "member_invited",
			invitation: { login: null, email: "someone@acme.dev" },
			organization,
			sender,
		})
		expect(byEmail.target).toEqual({ type: "user", id: undefined, name: "someone@acme.dev" })
	})

	it("sorts events by what they change", () => {
		const categoryOf = (event: string, action: string) =>
			mapped(event, { action, organization, repository, sender }).category
		expect(categoryOf("organization", "renamed")).toBe("configuration")
		expect(categoryOf("member", "edited")).toBe("permission")
		expect(categoryOf("member", "added")).toBe("membership")
		expect(categoryOf("team", "added_to_repository")).toBe("permission")
		expect(categoryOf("team", "created")).toBe("membership")
		expect(categoryOf("repository", "deleted")).toBe("resource")
		expect(categoryOf("repository", "publicized")).toBe("configuration")
		expect(categoryOf("branch_protection_rule", "deleted")).toBe("configuration")
		expect(categoryOf("repository_ruleset", "edited")).toBe("configuration")
		expect(categoryOf("deploy_key", "created")).toBe("credential")
		expect(categoryOf("personal_access_token_request", "approved")).toBe("credential")
		expect(categoryOf("org_block", "blocked")).toBe("permission")
		expect(categoryOf("installation", "deleted")).toBe("permission")
	})

	it("names a repository's protection with the repository it guards", () => {
		const event = mapped("branch_protection_rule", {
			action: "deleted",
			rule: { id: 900, name: "main" },
			repository,
			organization,
			sender,
		})
		expect(event.target).toEqual({ type: "branch_protection_rule", id: "900", name: "acme/api: main" })
	})

	it("counts the repositories an installation lost when there are several", () => {
		const event = mapped("installation_repositories", {
			action: "removed",
			repositories_removed: [
				{ id: 1, full_name: "acme/a" },
				{ id: 2, full_name: "acme/b" },
			],
			installation: { id: 42, account: { login: "acme" } },
			sender,
		})
		expect(event.account).toBe("acme")
		expect(event.target).toEqual({ type: "repository", name: "2 repositories" })
	})

	it("marks a bot as a service", () => {
		const event = mapped("repository", {
			action: "created",
			repository,
			sender: { login: "renovate[bot]", id: 9, type: "Bot" },
		})
		expect(event.actor).toEqual({ type: "service", id: "9", name: "renovate[bot]" })
		expect(event.account).toBe("acme")
	})

	it("names an event GitHub sends without an action as changed", () => {
		expect(mapped("security_and_analysis", { repository, organization, sender }).action).toBe(
			"security_and_analysis.changed",
		)
	})

	it("keeps the event but not an oversized payload's bulky objects", () => {
		const event = mapped("repository", {
			action: "edited",
			changes: { description: { from: "old" } },
			repository: { ...repository, description: Str.repeat(40_000)("x") },
			organization,
			sender,
		})
		expect(event.target?.name).toBe("acme/api")
		expect(event.raw).toEqual({ action: "edited", changes: { description: { from: "old" } } })
	})

	it("dates an event by its time-based delivery id, so a redelivery keeps the same time", () => {
		// A v1 UUID minted at 2025-11-13T02:13:20.000Z.
		const sentAt = Date.UTC(2025, 10, 13, 2, 13, 20)
		const id = "52e52000-c036-11f0-8000-4c9367dc0958"
		expect(deliveryTimeMs(id, sentAt + 5_000)).toBe(sentAt)
		expect(deliveryTimeMs(id, sentAt + 3_600_000)).toBe(sentAt)
		// Another id kind, or a time far from receipt, falls back to receipt.
		expect(deliveryTimeMs("3f1c2a52-8d1e-4b7a-9c2d-0e5f6a7b8c9d", 1_000)).toBe(1_000)
		// GitHub keeps deliveries three days for redelivery: one redelivered on the last day keeps its time.
		expect(deliveryTimeMs(id, sentAt + 3 * 86_400_000)).toBe(sentAt)
		expect(deliveryTimeMs(id, sentAt + 10 * 86_400_000)).toBe(sentAt + 10 * 86_400_000)
	})

	it("leaves out code and CI events, and a delivery without an id", () => {
		expect(Option.isNone(map("push", { ref: "refs/heads/main", repository, sender }, "d"))).toBe(true)
		expect(Option.isNone(map("workflow_run", { action: "completed", repository, sender }, "d"))).toBe(
			true,
		)
		expect(
			Option.isNone(map("organization", { action: "member_added", organization, sender }, undefined)),
		).toBe(true)
	})
})
