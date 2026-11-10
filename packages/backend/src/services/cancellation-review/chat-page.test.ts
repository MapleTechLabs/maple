import { CancellationModelRead } from "@maple/domain/http"
import { Array as Arr, Option, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { buildCancellationPageBlock, cancellationReportHtml } from "./chat-page"
import { CANCELLATION_FIXTURES } from "./fixtures"
import type { CancellationReport } from "./report"
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
			sessionsUrl: "https://app.test/replays?group=Acme&preset=30d",
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

const modelRead = (
	fields: Partial<ConstructorParameters<typeof CancellationModelRead>[0]>,
): CancellationModelRead =>
	new CancellationModelRead({
		company: null,
		findings: [],
		verdict: "agree",
		category: null,
		reason: null,
		conclusion: "",
		model: "test-model",
		...fields,
	})

/** The page's visible text, tags dropped and entities read back. */
const TEXT_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/<style>[\s\S]*?<\/style>/g, ""],
	[/<[^>]+>/g, " "],
	[/&#8220;|&#8221;/g, '"'],
	[/&#8217;/g, "'"],
	[/&#183;/g, "·"],
	[/&lt;/g, "<"],
	[/&gt;/g, ">"],
	[/&quot;/g, '"'],
	[/&amp;/g, "&"],
	[/\s+/g, " "],
]

const textOf = (html: string) =>
	Arr.reduce(TEXT_REPLACEMENTS, html, (text, [pattern, replacement]) =>
		Str.replace(pattern, replacement)(text),
	)

describe("cancellation report page", () => {
	it("escapes the org's name rather than letting it write markup", () => {
		const html = cancellationReportHtml(report("pipeline-off"))
		expect(html).not.toContain("<Labs>")
		expect(textOf(html)).toContain("Acme <Labs> & Co cancelled the startup plan")
	})

	it("says the customer skipped Stripe's survey, and leaves Stripe out when it could not be read", () => {
		expect(
			textOf(
				cancellationReportHtml(
					report("pipeline-off", { stripeFeedback: { feedback: null, comment: null } }),
				),
			),
		).toContain("Told Stripe Skipped the survey")
		expect(
			textOf(
				cancellationReportHtml(
					report("pipeline-off", {
						stripeFeedback: { feedback: "too_expensive", comment: "Way too much" },
					}),
				),
			),
		).toContain('Told Stripe too expensive · "Way too much"')
		expect(textOf(cancellationReportHtml(report("pipeline-off")))).not.toContain("Told Stripe")
	})

	it("leads with the model's reason when it overrides the rules, and keeps theirs beside it", () => {
		const text = textOf(
			cancellationReportHtml(
				report("pipeline-off", {
					modelRead: modelRead({
						verdict: "override",
						category: "cost",
						reason: "Overage charges",
					}),
				}),
			),
		)
		expect(text).toContain('Overage charges Model\'s read · rules said "Stopped sending telemetry"')
	})

	it("shows the company with its confidence apart from what the guess rests on", () => {
		const text = textOf(
			cancellationReportHtml(
				report("pipeline-off", {
					modelRead: modelRead({
						company: {
							name: "Rika Labs",
							oneLiner: "An applied research lab.",
							location: null,
							confidence: "high",
							basis: "org name and rikalabs.sh domain match",
						},
					}),
				}),
			),
		)
		expect(text).toContain(
			"Company High confidence Rika Labs An applied research lab. Org name and rikalabs.sh domain match",
		)
	})

	it("gives each stat a tile against the month before, worrying ones first", () => {
		const text = textOf(cancellationReportHtml(report("pipeline-off")))
		expect(text).toContain(
			"Telemetry 3.0 GB month before 42 GB last data 24 days ago Days in the app 2 month before 15",
		)
		expect(text).toContain("Setup 9 / 14 dashboards / alerts")
	})

	it("links only to http(s) addresses", () => {
		const html = cancellationReportHtml(
			report("pipeline-off", {
				subject: {
					...report("pipeline-off").subject,
					sessionsUrl: "javascript:alert(1)",
				},
			}),
		)
		expect(html).not.toContain("javascript:")
		expect(html).toContain('href="https://clerk.test/organizations/org_42"')
		expect(cancellationReportHtml(report("pipeline-off"))).toContain(
			'href="https://app.test/replays?group=Acme&amp;preset=30d"',
		)
	})

	it("carries the markdown report as the fallback for a platform that shows no page", () => {
		const block = buildCancellationPageBlock(report("pipeline-off"))
		expect(block.kind === "page" && block.fallback).toContain(
			"**Acme <Labs> & Co cancelled the startup plan**",
		)
	})
})
