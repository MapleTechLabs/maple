import { describe, expect, it } from "vitest"
import { CANCELLATION_FIXTURES } from "./fixtures"
import { deriveSignals, ruleReason } from "./signals"
import { buildCancellationMessage, type CancellationReport } from "./slack-message"

const report = (id: string, overrides: Partial<CancellationReport> = {}): CancellationReport => {
	const fixture = CANCELLATION_FIXTURES.find((candidate) => candidate.id === id)
	if (fixture === undefined) throw new Error(`no cancellation fixture named ${id}`)
	return {
		subject: {
			orgId: "org_42",
			orgName: "Acme <Labs> & Co",
			contactEmail: "dev@example.com",
			expiresAt: Date.parse("2026-10-19T00:00:00Z"),
			links: {
				clerk: "https://clerk.test/organizations/org_42",
				autumn: "https://autumn.test/customers/org_42",
				stripe: "https://stripe.test/customers/cus_42",
			},
			integrations: null,
			otherOrgs: null,
		},
		snapshot: fixture.snapshot,
		reason: ruleReason(fixture.snapshot),
		signals: deriveSignals(fixture.snapshot),
		...overrides,
	}
}

const text = (message: ReturnType<typeof buildCancellationMessage>) => JSON.stringify(message.blocks)

describe("buildCancellationMessage", () => {
	it("leads with the org, the plan's remaining access and the rule's reason", () => {
		const message = buildCancellationMessage(report("pipeline-off"))
		// The fallback is mrkdwn, where a raw `<!channel>` in an org name would ping; the header is plain text.
		expect(message.text).toBe("Plan cancelled: Acme &lt;Labs&gt; &amp; Co (Stopped sending telemetry)")
		expect(message.blocks[0]).toEqual({
			type: "header",
			text: { type: "plain_text", text: "Plan cancelled: Acme <Labs> & Co", emoji: true },
		})
		expect(message.blocks[1]).toEqual({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "`startup`  ·  access until Oct 19 (12d left)  ·  subscribed 240d  ·  org `org_42`",
				},
			],
		})
		expect(text(message)).toContain(":red_circle:  Stopped sending telemetry 24 days ago")
		expect(text(message)).toContain("*Likely reason*\\nStopped sending telemetry")
		expect(text(message)).toContain("*Contact*\\ndev@example.com")
		expect(text(message)).not.toContain("Could not read")
	})

	it("names the sections it could not read instead of showing zeros", () => {
		const base = report("healthy-team")
		const message = buildCancellationMessage({
			...base,
			snapshot: { ...base.snapshot, visits: null, billing: null },
		})
		expect(text(message)).toContain("Could not read: app visits, billing")
		expect(text(message)).not.toContain("Days in the app")
	})

	it("escapes markup in the sentences and the contact", () => {
		const base = report("healthy-team")
		const message = buildCancellationMessage({
			...base,
			subject: { ...base.subject, contactEmail: "a&b@example.com" },
			signals: [{ tone: "neutral", text: "Past the included allowance on <logs>" }],
		})
		expect(text(message)).toContain("a&amp;b@example.com")
		expect(text(message)).toContain("allowance on &lt;logs&gt;")
	})

	it("says the plan ended for an immediate cancellation", () => {
		const message = buildCancellationMessage(report("past-due"))
		expect(message.text).toBe("Plan ended: Acme &lt;Labs&gt; &amp; Co (Payment failed)")
		expect(text(message)).toContain("access ended")
	})

	it("links the org in Clerk, Stripe and Autumn, leaving out Stripe when there is no customer", () => {
		const base = report("healthy-team")
		expect(text(buildCancellationMessage(base))).toContain(
			"<https://clerk.test/organizations/org_42|Clerk>  ·  <https://stripe.test/customers/cus_42|Stripe>  ·  <https://autumn.test/customers/org_42|Autumn>",
		)
		const noStripe = buildCancellationMessage({
			...base,
			subject: { ...base.subject, links: { ...base.subject.links, stripe: null } },
		})
		expect(text(noStripe)).not.toContain("|Stripe>")
	})

	it("lists each integration with its icon, and each chat connector as its own row", () => {
		const base = report("healthy-team")
		const resource = (kind: string, name: string, note: string | null = null) => ({
			kind,
			name,
			status: "healthy" as const,
			lastSuccessAt: null,
			lastError: null,
			note,
		})
		const message = buildCancellationMessage({
			...base,
			subject: {
				...base.subject,
				integrations: [
					{
						provider: "github",
						status: "failing",
						account: "acme",
						connectedAt: null,
						problem: null,
						feeds: [],
						resources: [resource("repository", "api"), resource("repository", "web")],
					},
					{
						provider: "chat",
						status: "healthy",
						account: null,
						connectedAt: null,
						problem: null,
						feeds: [],
						resources: [
							resource("workspace", "Acme", "slack"),
							resource("workspace", "Acme HQ", "discord"),
						],
					},
				],
			},
		})
		const rows = message.blocks.filter(
			(block) => block.type === "context" && JSON.stringify(block).includes("favicons"),
		)
		expect(rows.map((row) => JSON.stringify(row))).toEqual([
			expect.stringContaining("*GitHub*  acme  ·  2 repositories  ·  failing"),
			expect.stringContaining("*Slack*  Acme"),
			expect.stringContaining("*Discord*  Acme HQ"),
		])
		expect(JSON.stringify(rows[0])).toContain("domain=github.com")

		const none = buildCancellationMessage({ ...base, subject: { ...base.subject, integrations: [] } })
		expect(text(none)).toContain("None connected")
	})

	it("names the members' other orgs and who links them", () => {
		const base = report("healthy-team")
		const message = buildCancellationMessage({
			...base,
			subject: {
				...base.subject,
				otherOrgs: [
					{
						orgId: "org_new",
						name: "Acme (new)",
						createdAtMs: Date.parse("2026-10-03T00:00:00Z"),
						membersCount: 2,
						sharedMembers: ["a@acme.test", "b@acme.test"],
						clerkUrl: "https://clerk.test/organizations/org_new",
					},
				],
			},
		})
		expect(text(message)).toContain(
			"<https://clerk.test/organizations/org_new|Acme (new)> `org_new`  created Oct 3, 2 members, via a@acme.test, b@acme.test",
		)
		const none = buildCancellationMessage({ ...base, subject: { ...base.subject, otherOrgs: [] } })
		expect(text(none)).toContain("*Members' other orgs*\\nNone")
	})
})
