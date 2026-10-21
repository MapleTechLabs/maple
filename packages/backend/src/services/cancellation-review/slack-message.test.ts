import type { IntegrationEntry } from "@maple/domain/integration-inventory"
import { describe, expect, it } from "vitest"
import { CANCELLATION_FIXTURES } from "./fixtures"
import { deriveSignals, ruleReason } from "./signals"
import {
	buildCancellationMessage,
	type CancellationReport,
	OTHER_ORGS_SHOWN,
	type OtherOrg,
} from "./slack-message"

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

type Message = ReturnType<typeof buildCancellationMessage>

const text = (message: Message) => JSON.stringify(message.blocks)

const fieldsOf = (message: Message) =>
	message.blocks.flatMap((block) =>
		Array.isArray(block.fields) ? block.fields.map((field: { text: string }) => field.text) : [],
	)

const withSubject = (base: CancellationReport, subject: Partial<CancellationReport["subject"]>) =>
	buildCancellationMessage({ ...base, subject: { ...base.subject, ...subject } })

const resource = (kind: string, name: string, note: string | null = null) => ({
	kind,
	name,
	status: "healthy" as const,
	lastSuccessAt: null,
	lastError: null,
	note,
})

const integration = (overrides: Partial<IntegrationEntry>): IntegrationEntry => ({
	provider: "github",
	status: "healthy",
	account: null,
	connectedAt: null,
	problem: null,
	feeds: [],
	resources: [],
	...overrides,
})

const otherOrg = (overrides: Partial<OtherOrg> = {}): OtherOrg => ({
	orgId: "org_new",
	name: "Acme (new)",
	createdAtMs: Date.parse("2026-10-03T00:00:00Z"),
	membersCount: 2,
	sharedMembers: ["a@acme.test", "b@acme.test"],
	links: {
		clerk: "https://clerk.test/organizations/org_new",
		autumn: "https://autumn.test/customers/org_new",
		stripe: "https://stripe.test/customers/cus_new",
	},
	billing: { plan: "pro" },
	...overrides,
})

describe("buildCancellationMessage", () => {
	it("leads with the org, the plan's remaining access and the rule's reason", () => {
		const message = buildCancellationMessage(report("pipeline-off"))
		// The fallback is mrkdwn, where a raw `<!channel>` in an org name would ping; the header is plain text.
		expect(message.text).toBe(
			"Acme &lt;Labs&gt; &amp; Co cancelled the startup plan (Stopped sending telemetry)",
		)
		expect(message.blocks[0]).toEqual({
			type: "header",
			text: { type: "plain_text", text: "Acme <Labs> & Co cancelled the startup plan", emoji: true },
		})
		expect(message.blocks[1]).toEqual({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "Access until Oct 19 (12d left)  ·  subscribed 240 days  ·  contact dev@example.com  ·  `org_42`",
				},
			],
		})
		expect(text(message)).toContain("*Likely reason:* Stopped sending telemetry")
		expect(text(message)).not.toContain("Could not read")
	})

	it("puts each stat's number first, its change under it, and marks the worrying ones", () => {
		expect(fieldsOf(buildCancellationMessage(report("pipeline-off")))).toEqual([
			":red_circle: Telemetry, 30d\n*3.0 GB*\ndown from 42 GB · last data 24 days ago",
			":red_circle: In the app, 30d\n*2 days*\ndown from 15 · peak 1 person a day · last visit 20 days ago",
			"Members\n*5*",
			"Last invoice\n*$39*\nsame as the month before",
			"Set up\n*9 dashboards*\n14 alert rules",
		])
		expect(fieldsOf(buildCancellationMessage(report("healthy-team")))[0]).toBe(
			":large_green_circle: Telemetry, 30d\n*38 GB*\nup from 35 GB",
		)
	})

	it("lists what no stat covers, such as a past-due payment, under the reason", () => {
		const message = buildCancellationMessage(report("past-due"))
		expect(message.text).toBe("Acme &lt;Labs&gt; &amp; Co ended the startup plan (Payment failed)")
		expect(text(message)).toContain("Access ended Oct 19")
		expect(message.blocks[4]).toEqual({
			type: "context",
			elements: [{ type: "mrkdwn", text: ":red_circle: Payment is past due" }],
		})
	})

	it("names the sections it could not read instead of showing zeros", () => {
		const base = report("healthy-team")
		const snapshot = { ...base.snapshot, visits: null, billing: null }
		const message = buildCancellationMessage({ ...base, snapshot, signals: deriveSignals(snapshot) })
		expect(text(message)).toContain("Could not read: app visits, billing")
		expect(text(message)).not.toContain("In the app")
	})

	it("escapes markup in the sentences and the contact", () => {
		const base = report("healthy-team")
		const message = buildCancellationMessage({
			...base,
			subject: { ...base.subject, contactEmail: "a&b@example.com" },
			signals: [{ topic: "plan", tone: "neutral", text: "Past the included allowance on <logs>" }],
		})
		expect(text(message)).toContain("a&amp;b@example.com")
		expect(text(message)).toContain("allowance on &lt;logs&gt;")
	})

	it("links the org in Clerk, Stripe and Autumn as buttons, leaving out Stripe when there is no customer", () => {
		const base = report("healthy-team")
		const buttons = (message: Message) =>
			message.blocks
				.filter((block) => block.type === "actions")
				.flatMap((block) => block.elements as Array<{ text: { text: string }; url: string }>)
				.map((button) => [button.text.text, button.url])
		expect(buttons(buildCancellationMessage(base))).toEqual([
			["Clerk", "https://clerk.test/organizations/org_42"],
			["Stripe", "https://stripe.test/customers/cus_42"],
			["Autumn", "https://autumn.test/customers/org_42"],
		])
		const noStripe = withSubject(base, { links: { ...base.subject.links, stripe: null } })
		expect(buttons(noStripe).map(([label]) => label)).toEqual(["Clerk", "Autumn"])
	})

	it("lists each integration with its icon, and each chat connector as its own row", () => {
		const base = report("healthy-team")
		const message = withSubject(base, {
			integrations: [
				integration({
					status: "failing",
					account: "acme",
					resources: [resource("repository", "api"), resource("repository", "web")],
				}),
				integration({
					provider: "chat",
					resources: [
						resource("workspace", "Acme", "slack"),
						resource("workspace", "Acme HQ", "discord"),
					],
				}),
			],
		})
		const rows = message.blocks.filter(
			(block) => block.type === "context" && JSON.stringify(block).includes("favicons"),
		)
		expect(rows.map((row) => JSON.stringify(row))).toEqual([
			expect.stringContaining("*GitHub*  acme  ·  2 repositories  ·  :red_circle: failing"),
			expect.stringContaining("*Slack*  Acme"),
			expect.stringContaining("*Discord*  Acme HQ"),
		])
		expect(JSON.stringify(rows[0])).toContain("domain=github.com")

		expect(text(withSubject(base, { integrations: [] }))).toContain("None connected")
	})

	it("counts Cloudflare's per-zone datasets instead of listing each one", () => {
		const message = withSubject(report("healthy-team"), {
			integrations: [
				integration({
					provider: "cloudflare",
					account: "Kevin",
					resources: ["a.com", "b.com"].flatMap((zone) => [
						resource("zone", zone),
						resource("dns_queries", zone),
						resource("firewall_events", zone),
					]),
				}),
			],
		})
		expect(text(message)).toContain("*Cloudflare*  Kevin  ·  2 zones  ·  2 datasets")
	})

	it("names the members' other orgs with their plan, who links them and where to look them up", () => {
		const base = report("healthy-team")
		const message = withSubject(base, {
			otherOrgs: [otherOrg(), otherOrg({ orgId: "org_old", name: "Old", billing: null })],
		})
		expect(text(message)).toContain("*Acme (new)*  `org_new`")
		expect(text(message)).toContain(
			"Created Oct 3  ·  2 members  ·  `pro`  ·  via a@acme.test, b@acme.test  ·  <https://clerk.test/organizations/org_new|Clerk>  ·  <https://stripe.test/customers/cus_new|Stripe>  ·  <https://autumn.test/customers/org_new|Autumn>",
		)
		// Autumn unread: no plan claimed either way.
		expect(text(message)).toContain("*Old*  `org_old`")
		expect(text(message)).toContain("Created Oct 3  ·  2 members  ·  via a@acme.test")

		const noPlan = withSubject(base, { otherOrgs: [otherOrg({ billing: { plan: null } })] })
		expect(text(noPlan)).toContain("2 members  ·  no plan  ·  via")
	})

	it("says so when the members have no other orgs, and when that could not be checked", () => {
		const base = report("healthy-team")
		expect(text(withSubject(base, { otherOrgs: [] }))).toContain(
			"None. Every member belongs only to this org.",
		)
		expect(text(withSubject(base, { otherOrgs: null }))).toContain(
			"Could not check: the Clerk lookup failed",
		)
	})

	it("stays under Slack's block limit however many other orgs there are", () => {
		const many = Array.from({ length: 30 }, (_, index) => otherOrg({ orgId: `org_${index}` }))
		const message = withSubject(report("healthy-team"), { otherOrgs: many })
		expect(message.blocks.length).toBeLessThanOrEqual(50)
		expect(text(message)).toContain(`And ${30 - OTHER_ORGS_SHOWN} older orgs`)
	})
})
