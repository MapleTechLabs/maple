import { CancellationModelRead, CancellationSnapshot } from "@maple/domain/http"
import type { IntegrationEntry } from "@maple/domain/integration-inventory"
import { Array as Arr, Option, Predicate, String as Str } from "effect"
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
	const fixture = Option.getOrUndefined(
		Arr.findFirst(CANCELLATION_FIXTURES, (candidate) => candidate.id === id),
	)
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
			sessionsUrl: "https://app.test/replays?group=Acme&timePreset=30d",
			integrations: null,
			otherOrgs: null,
		},
		snapshot: fixture.snapshot,
		reason: ruleReason(fixture.snapshot),
		signals: deriveSignals(fixture.snapshot),
		modelRead: null,
		stripeFeedback: null,
		unreadEvidence: [],
		...overrides,
	}
}

type Message = ReturnType<typeof buildCancellationMessage>

const text = (message: Message) => JSON.stringify(message.blocks)

interface TableCell {
	readonly text?: string
	readonly elements?: ReadonlyArray<{ readonly elements: ReadonlyArray<{ text?: string; name?: string }> }>
}

/** The stats table as plain rows, an emoji cell part written as `:name:`. */
const tableOf = (message: Message) => {
	const tables = Arr.filter(message.blocks, (block) => block.type === "table")
	return Arr.flatMap(tables, (block) =>
		Arr.map(block.rows as ReadonlyArray<ReadonlyArray<TableCell>>, (row) =>
			Arr.map(
				row,
				(cell) =>
					cell.text ??
					Arr.join(
						Arr.map(
							Arr.flatMap(cell.elements ?? [], (section) => section.elements),
							(part) => part.text ?? `:${part.name}:`,
						),
						"",
					),
			),
		),
	)
}

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

const modelRead = (overrides: Partial<ConstructorParameters<typeof CancellationModelRead>[0]> = {}) =>
	new CancellationModelRead({
		company: null,
		findings: [],
		verdict: "agree",
		category: null,
		reason: null,
		conclusion: "",
		model: "test-model",
		...overrides,
	})

describe("buildCancellationMessage", () => {
	it("adds nothing when the model agrees and has nothing to say", () => {
		const plain = buildCancellationMessage(report("pipeline-off"))
		expect(buildCancellationMessage(report("pipeline-off", { modelRead: modelRead() }))).toEqual(plain)
	})

	it("names the likely company under the links, with what it rests on", () => {
		const message = buildCancellationMessage(
			report("pipeline-off", {
				modelRead: modelRead({
					company: {
						name: "Acme <Robotics>",
						oneLiner: "Warehouse robots",
						location: "Berlin, DE",
						confidence: "medium",
						basis: "domain, homepage",
					},
				}),
			}),
		)
		expect(message.blocks[3]).toEqual({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: ":office: *Acme &lt;Robotics&gt;*, Berlin, DE: Warehouse robots  _(medium confidence: domain, homepage)_",
					verbatim: true,
				},
			],
		})
	})

	it("lists the findings as facts and then the model's opinion, after the rules' reason", () => {
		const message = buildCancellationMessage(
			report("pipeline-off", {
				modelRead: modelRead({
					findings: [
						"Revoked both ingest keys on <Oct 6>.",
						"Cloudflare failing since 12 days before.",
					],
					conclusion: "Moved off Maple after the integration broke.",
				}),
			}),
		)
		const all = text(message)
		expect(all).toContain(
			Str.slice(
				1,
				-1,
			)(
				JSON.stringify(
					"*What stands out*\n• Revoked both ingest keys on &lt;Oct 6&gt;.\n• Cloudflare failing since 12 days before.",
				),
			),
		)
		expect(all).toContain(":robot_face: *Model's read:* Moved off Maple after the integration broke.")
		expect(Option.getOrElse(Str.indexOf("Likely reason")(all), () => -1)).toBeLessThan(
			Option.getOrElse(Str.indexOf("What stands out")(all), () => -1),
		)
	})

	it("leads with the model's reason when it overrides the rules, and keeps theirs beside it", () => {
		const message = buildCancellationMessage(
			report("pipeline-off", {
				modelRead: modelRead({
					verdict: "override",
					category: "missing_features",
					reason: "Needed SSO",
				}),
			}),
		)
		expect(message.text).toBe("Acme &lt;Labs&gt; &amp; Co cancelled the startup plan (Needed SSO)")
		expect(text(message)).toContain(
			"*Likely reason:* Needed SSO  _(model's read; rules said: Stopped sending telemetry)_",
		)
	})

	it("never turns a URL in the customer's or the model's words into a link", () => {
		const message = buildCancellationMessage(
			report("pipeline-off", {
				stripeFeedback: { feedback: null, comment: "see https://evil.test" },
				modelRead: modelRead({
					findings: ["Homepage says https://evil.test"],
					conclusion: "Visit https://evil.test now.",
				}),
			}),
		)
		const withUrl = Arr.filter(
			Arr.flatMap(message.blocks, (block) => [
				block.text,
				...(Arr.isArray(block.elements) ? block.elements : []),
			]),
			(part) =>
				Predicate.hasProperty(part, "text") &&
				typeof part.text === "string" &&
				Str.includes("evil.test")(part.text),
		)
		expect(withUrl).toHaveLength(3)
		for (const part of withUrl) expect(part).toMatchObject({ verbatim: true })
	})

	it("names the evidence it could not read", () => {
		const message = buildCancellationMessage(report("pipeline-off", { unreadEvidence: ["Stripe"] }))
		expect(text(message)).toContain("Could not read: Stripe")
	})

	it("quotes what the customer told Stripe, and nothing when they skipped it", () => {
		const told = buildCancellationMessage(
			report("pipeline-off", {
				stripeFeedback: { feedback: "too_expensive", comment: "Too much for <us>" },
			}),
		)
		expect(text(told)).toContain("*Told Stripe:* too expensive “Too much for &lt;us&gt;”")
		const skipped = buildCancellationMessage(
			report("pipeline-off", { stripeFeedback: { feedback: null, comment: null } }),
		)
		expect(text(skipped)).not.toContain("Told Stripe")
	})

	it("cuts free text short enough that Slack never refuses the report", () => {
		const long = Str.repeat(5_000)("x")
		const message = buildCancellationMessage(
			report("pipeline-off", {
				stripeFeedback: { feedback: null, comment: long },
				modelRead: modelRead({
					verdict: "override",
					reason: long,
					findings: [long],
					conclusion: long,
					company: { name: long, oneLiner: long, location: long, confidence: "low", basis: long },
				}),
			}),
		)
		const texts = Arr.flatMap(message.blocks, (block) =>
			Arr.flatMap([block.text, ...(Arr.isArray(block.elements) ? block.elements : [])], (part) =>
				Predicate.hasProperty(part, "text") && typeof part.text === "string" ? [part.text] : [],
			),
		)
		expect(Math.max(...Arr.map(texts, (value) => value.length))).toBeLessThan(3_000)
	})

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

	it("tables each stat against the month before, worrying rows first", () => {
		expect(tableOf(buildCancellationMessage(report("pipeline-off")))).toEqual([
			["Last 30 days", "Now", "Month before"],
			[":red_circle: Telemetry", "3.0 GB", "42 GB · last data 24 days ago"],
			[":red_circle: Days in the app", "2", "15 · peak 1 person a day · last visit 20 days ago"],
			["Members", "5", "—"],
			["Last invoice", "$39", "$39"],
			["Dashboards / alerts", "9 / 14", "—"],
		])
		expect(tableOf(buildCancellationMessage(report("healthy-team")))[1]).toEqual([
			":large_green_circle: Telemetry",
			"38 GB",
			"35 GB",
		])
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
		const snapshot = new CancellationSnapshot({ ...base.snapshot, visits: null, billing: null })
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

	it("links the org in Clerk, Stripe, Autumn and its sessions as buttons, leaving out what it has no link for", () => {
		const base = report("healthy-team")
		const buttons = (message: Message) => {
			const actions = Arr.filter(message.blocks, (block) => block.type === "actions")
			return Arr.map(
				Arr.flatMap(
					actions,
					(block) => block.elements as Array<{ text: { text: string }; url: string }>,
				),
				(button) => [button.text.text, button.url],
			)
		}
		expect(buttons(buildCancellationMessage(base))).toEqual([
			["Clerk", "https://clerk.test/organizations/org_42"],
			["Stripe", "https://stripe.test/customers/cus_42"],
			["Autumn", "https://autumn.test/customers/org_42"],
			["Sessions", "https://app.test/replays?group=Acme&timePreset=30d"],
		])
		const noStripe = withSubject(base, {
			links: { ...base.subject.links, stripe: null },
			sessionsUrl: null,
		})
		expect(Arr.map(buttons(noStripe), ([label]) => label)).toEqual(["Clerk", "Autumn"])
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
		const rows = Arr.filter(
			message.blocks,
			(block) => block.type === "context" && Str.includes("favicons")(JSON.stringify(block)),
		)
		expect(Arr.map(rows, (row) => JSON.stringify(row))).toEqual([
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
					resources: Arr.flatMap(["a.com", "b.com"], (zone) => [
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
