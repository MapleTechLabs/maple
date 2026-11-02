import type { SupabaseLogIssue } from "@maple/domain/http"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { eyebrow } from "../../../../ui/eyebrow"
import { FLEET_INSIGHTS_LIMIT } from "../data"
import { logSourceLabel, severityOf } from "../health"
import { supabaseLogsHref } from "../links"
import { keyedBody, MANAGE_HREF, panelEmpty, panelLink, panelMeta, sectionPanel } from "../panel"
import type { SupabaseFleetInsights } from "../model"
import { type AdvisorFinding, advisorFindings, advisorsChecked } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The overview's bottom row: recurring log issues across projects, and advisor findings.

type H = HtmlBuilder<Message>

const MAX_ROWS = 6

const listRow = (h: H, key: string, href: string | null, children: ReadonlyArray<Html>): Html => {
	const className =
		"flex items-center gap-4 border-t border-border-subtle px-4 py-2.5 first:border-t-0 transition-colors"
	return h.li(
		[h.Key(key)],
		[
			href === null
				? h.div([h.Class(className)], children)
				: h.a([h.Href(href), h.Class(cn(className, "hover:bg-surface-sunken active:bg-surface-sunken"))], children),
		],
	)
}

const issueRow = (
	h: H,
	issue: SupabaseLogIssue,
	names: ReadonlyMap<string, string>,
	search: Model["search"],
) => {
	const severity = severityOf(issue.maxSeverity)
	return listRow(
		h,
		`${issue.projectRef}:${issue.source}:${issue.message}`,
		supabaseLogsHref(search, issue.projectRef),
		[
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[
					h.span(
						[h.Class("truncate font-mono text-xs text-foreground"), h.Title(issue.message)],
						[issue.message],
					),
					h.span(
						[h.Class("truncate font-mono text-2xs text-muted-foreground")],
						[
							h.span([h.Class(TONE_TEXT[severity.tone])], [severity.label]),
							` · ${names.get(issue.projectRef) ?? issue.projectRef} · ${logSourceLabel(issue.source)}`,
						],
					),
				],
			),
			panelMeta(h, `${formatNumber(issue.count)}×`, "shrink-0"),
		],
	)
}

export const issuesPanel = (
	h: H,
	model: Model,
	options: Readonly<{ names: ReadonlyMap<string, string>; hasLogs: boolean }>,
): Html =>
	sectionPanel(
		h,
		{
			title: "Top errors across projects",
			action: panelLink(h, supabaseLogsHref(model.search), "All logs"),
		},
		[
			keyedBody(h, model.issues, {
				rows: 4,
				failureTitle: "Couldn't load errors and warnings",
				onRetry: Message.ClickedRetryIssues(),
				render: (response) =>
					response.issues.length > 0
						? h.ul(
								[h.AriaLabel("Top errors across projects")],
								response.issues
									.slice(0, MAX_ROWS)
									.map((issue) => issueRow(h, issue, options.names, model.search)),
							)
						: options.hasLogs
							? panelEmpty(h, ["No warnings or errors in this window"])
							: panelEmpty(h, [
									"Turn on Logs for a project to see its warnings and errors here. ",
									panelLink(h, MANAGE_HREF, "Manage projects"),
								]),
			}),
		],
	)

const findingRow = (h: H, finding: AdvisorFinding): Html =>
	listRow(
		h,
		`${finding.projectRef}:${finding.lint.cacheKey}`,
		hrefOf(AppRoute.InfraSupabaseProject({ projectRef: finding.projectRef, search: {} })),
		[
			eyebrow(
				h,
				{
					className: cn(
						"w-24 shrink-0",
						TONE_TEXT[finding.lint.level === "ERROR" ? "crit" : "warn"],
					),
				},
				[finding.lint.advisor === "security" ? "Security" : "Performance"],
			),
			h.span(
				[h.Class("min-w-0 flex-1 truncate text-xs text-foreground"), h.Title(finding.lint.title)],
				[finding.lint.title],
			),
			h.span(
				[h.Class("max-w-40 shrink-0 truncate font-mono text-2xs text-muted-foreground")],
				[finding.projectName],
			),
		],
	)

const findingsBody = (
	h: H,
	fleet: SupabaseFleetInsights,
	names: ReadonlyMap<string, string>,
	total: number,
): Html => {
	const findings = advisorFindings(fleet, names)
	const notes = [
		...(fleet.failedRefs.length > 0
			? [`Advisors could not be read for ${countLabel(fleet.failedRefs.length, "project")}.`]
			: []),
		...(total > FLEET_INSIGHTS_LIMIT ? [`Showing the first ${FLEET_INSIGHTS_LIMIT} projects.`] : []),
	]
	const body =
		findings.length > 0
			? h.ul(
					[h.AriaLabel("Advisor findings")],
					findings.slice(0, MAX_ROWS).map((finding) => findingRow(h, finding)),
				)
			: advisorsChecked(fleet)
				? panelEmpty(h, ["No security or performance findings"])
				: fleet.insights.length === 0 && fleet.failedRefs.length > 0
					? panelEmpty(h, ["Advisors could not be read"])
					: panelEmpty(h, ["Advisors are checked every hour. The first check has not run yet."])
	return h.div(
		[],
		[
			body,
			...notes.map((note) =>
				h.p(
					[
						h.Key(note),
						h.Class("border-t border-border-subtle px-4 py-2 text-2xs text-muted-foreground"),
					],
					[note],
				),
			),
		],
	)
}

export const advisorsPanel = (
	h: H,
	model: Model,
	options: Readonly<{ names: ReadonlyMap<string, string>; total: number }>,
): Html =>
	sectionPanel(
		h,
		{
			title: "Advisor findings",
			action: panelMeta(h, "security and performance lints"),
		},
		[
			keyedBody(h, model.insights, {
				rows: 4,
				failureTitle: "Couldn't load advisor findings",
				onRetry: Message.ClickedRetryInsights(),
				render: (fleet) => findingsBody(h, fleet, options.names, options.total),
			}),
		],
	)
