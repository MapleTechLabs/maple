import type { SupabaseLogIssue } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { formatClockInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../../ui/display"
import { logSourceLabel, severityOf } from "../health"
import { Message } from "./message"
import type { Model } from "./model"
import { keyedBody, MANAGE_HREF, panelEmpty, panelLink, sectionPanel } from "../panel"

// "Errors and warnings": the project's recurring WARN+ log messages.

type H = HtmlBuilder<Message>

const issueRow = (h: H, issue: SupabaseLogIssue, timeZone: string): Html => {
	const severity = severityOf(issue.maxSeverity)
	return h.li(
		[
			h.Key(`${issue.source}:${issue.message}`),
			h.Class("flex items-center gap-4 border-t border-border/60 px-4 py-2 text-xs first:border-t-0"),
		],
		[
			h.span(
				[h.Class("w-16 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground")],
				[formatClockInTimezone(issue.lastSeen, { timeZone })],
			),
			h.span(
				[h.Class(cn("w-12 shrink-0 font-mono text-2xs font-medium", TONE_TEXT[severity.tone]))],
				[severity.label],
			),
			h.span(
				[h.Class("w-20 shrink-0")],
				[badge(h, { variant: "meta", mono: true }, [logSourceLabel(issue.source)])],
			),
			h.span(
				[h.Class("min-w-0 flex-1 truncate font-mono text-foreground"), h.Title(issue.message)],
				[issue.message],
			),
			h.span(
				[h.Class("shrink-0 font-mono text-2xs tabular-nums text-muted-foreground")],
				[`${formatNumber(issue.count)}×`],
			),
		],
	)
}

export const issuesPanel = (
	h: H,
	model: Model,
	options: Readonly<{ timeZone: string; isLogsEnabled: boolean; logsHref: string }>,
): Html =>
	sectionPanel(
		h,
		{
			title: "Errors and warnings",
			description: "Postgres, Auth, REST, Storage and Realtime logs",
			action: panelLink(h, options.logsHref, "All logs"),
		},
		[
			keyedBody(h, model.issues, {
				rows: 4,
				failureTitle: "Couldn't load errors and warnings",
				onRetry: Message.ClickedRetry({ section: "issues" }),
				render: (response) =>
					response.issues.length > 0
						? h.ul(
								[h.AriaLabel("Errors and warnings")],
								response.issues.map((issue) => issueRow(h, issue, options.timeZone)),
							)
						: options.isLogsEnabled
							? panelEmpty(h, ["No warnings or errors in this time range."])
							: panelEmpty(h, [
									"Turn on Logs for this project to see its warnings and errors here. ",
									panelLink(h, MANAGE_HREF, "Manage projects"),
								]),
			}),
		],
	)
