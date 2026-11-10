import type { ChatBlock } from "@maple/chat-platform"
import { CancellationModelRead } from "@maple/domain/http"
import { Array as Arr, Option, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { buildCancellationChatBlocks } from "./chat-message"
import { CANCELLATION_FIXTURES } from "./fixtures"
import { type CancellationReport, OTHER_ORGS_SHOWN, type OtherOrg } from "./report"
import { deriveSignals, ruleReason } from "./signals"

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
			sessionsUrl: "https://app.test/replays?group=Acme",
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

const sections = (blocks: ReadonlyArray<ChatBlock>): ReadonlyArray<string> =>
	Arr.map(blocks, (block) => (block.kind === "prose" ? block.markdown : `<${block.kind}>`))

const markdownOf = (base: CancellationReport) => Arr.join(sections(buildCancellationChatBlocks(base)), "\n")

/** The section that starts with `heading`, line by line. */
const section = (base: CancellationReport, heading: string) =>
	Option.getOrUndefined(
		Option.map(
			Arr.findFirst(sections(buildCancellationChatBlocks(base)), Str.startsWith(heading)),
			Str.split("\n"),
		),
	)

const otherOrg = (overrides: Partial<OtherOrg> = {}): OtherOrg => ({
	orgId: "org_new",
	name: "Acme (new)",
	createdAtMs: Date.parse("2026-10-03T00:00:00Z"),
	membersCount: 2,
	sharedMembers: ["a@acme.test"],
	links: {
		clerk: "https://clerk.test/organizations/org_new",
		autumn: "https://autumn.test/customers/org_new",
		stripe: null,
	},
	billing: { plan: "pro" },
	...overrides,
})

describe("buildCancellationChatBlocks", () => {
	it("leads with the org as written, the plan's remaining access and every link", () => {
		expect(sections(buildCancellationChatBlocks(report("pipeline-off")))[0]).toBe(
			Arr.join(
				[
					"**Acme <Labs> & Co cancelled the startup plan**",
					"Access until Oct 19 (12d left)  ·  subscribed 240 days  ·  contact dev@example.com  ·  `org_42`",
					"[Clerk](https://clerk.test/organizations/org_42)  ·  [Stripe](https://stripe.test/customers/cus_42)  ·  [Autumn](https://autumn.test/customers/org_42)  ·  [Sessions](https://app.test/replays?group=Acme)",
				],
				"\n",
			),
		)
		expect(markdownOf(report("pipeline-off"))).toContain("**Likely reason:** Stopped sending telemetry")
	})

	it("lists each stat against the month before, worrying rows first", () => {
		expect(section(report("pipeline-off"), "**Last 30 days**")).toEqual([
			"**Last 30 days**",
			"- 🔴 Telemetry: **3.0 GB** (month before 42 GB · last data 24 days ago)",
			"- 🔴 Days in the app: **2** (month before 15 · peak 1 person a day · last visit 20 days ago)",
			"- Members: **5**",
			"- Last invoice: **$39** (month before $39)",
			"- Dashboards / alerts: **9 / 14**",
		])
	})

	it("lists what no stat covers, such as a past-due payment, after the reason", () => {
		const shown = sections(buildCancellationChatBlocks(report("past-due")))
		expect(shown).toContain("🔴 Payment is past due")
		expect(shown.indexOf("🔴 Payment is past due")).toBeGreaterThan(
			Option.getOrElse(Arr.findFirstIndex(shown, Str.startsWith("**Likely reason:**")), () => -1),
		)
	})

	it("quotes the model's company and read and the customer's words, with its findings as a list", () => {
		const shown = sections(
			buildCancellationChatBlocks(
				report("pipeline-off", {
					stripeFeedback: { feedback: "too_expensive", comment: "Too much" },
					modelRead: new CancellationModelRead({
						company: {
							name: "Acme Robotics",
							oneLiner: "Warehouse robots",
							location: "Berlin, DE",
							confidence: "medium",
							basis: "domain",
						},
						findings: ["Revoked both ingest keys.", "Cloudflare failing."],
						verdict: "override",
						category: "missing_features",
						reason: "Needed SSO",
						conclusion: "Moved off Maple after the integration broke.",
						model: "test-model",
					}),
				}),
			),
		)
		expect(shown.slice(1, 6)).toEqual([
			"> 🏢 **Acme Robotics**, Berlin, DE: Warehouse robots  _(medium confidence: domain)_",
			"**Likely reason:** Needed SSO  _(model's read; rules said: Stopped sending telemetry)_",
			"> **Told Stripe:** too expensive “Too much”",
			"**What stands out**\n- Revoked both ingest keys.\n- Cloudflare failing.",
			"> 🤖 **Model's read:** Moved off Maple after the integration broke.",
		])
	})

	it("lists integrations and the members' other orgs, and says when there are none", () => {
		const base = report("healthy-team")
		const listed = {
			...base,
			subject: {
				...base.subject,
				integrations: [
					{
						provider: "github",
						status: "failing" as const,
						account: "acme",
						connectedAt: null,
						problem: null,
						feeds: [],
						resources: [],
					},
				],
				otherOrgs: Arr.makeBy(OTHER_ORGS_SHOWN + 1, (index) => otherOrg({ orgId: `org_${index}` })),
			},
		}
		expect(section(listed, "**Integrations**")).toEqual([
			"**Integrations**",
			"- **GitHub**  acme  ·  🔴 failing",
		])
		const orgs = section(listed, "**Members' other orgs**") ?? []
		expect(orgs.slice(1, 3)).toEqual([
			"**Acme (new)**  `org_0`",
			"Created Oct 3  ·  2 members  ·  `pro`  ·  via a@acme.test  ·  [Clerk](https://clerk.test/organizations/org_new)  ·  [Autumn](https://autumn.test/customers/org_new)",
		])
		expect(orgs.at(-1)).toBe("And 1 older org")

		const none = { ...base, subject: { ...base.subject, integrations: [], otherOrgs: [] } }
		expect(section(none, "**Integrations**")).toEqual(["**Integrations**", "None connected"])
		expect(section(none, "**Members' other orgs**")).toEqual([
			"**Members' other orgs**",
			"None. Every member belongs only to this org.",
		])
		expect(markdownOf(base)).not.toContain("**Integrations**")
		expect(markdownOf(base)).toContain("Could not check: the Clerk lookup failed")
	})

	it("names what it could not read, and nothing when it read everything", () => {
		expect(
			sections(buildCancellationChatBlocks(report("pipeline-off", { unreadEvidence: ["Stripe"] }))).at(
				-1,
			),
		).toBe("_Could not read: Stripe_")
		expect(markdownOf(report("pipeline-off"))).not.toContain("Could not read")
	})
})
