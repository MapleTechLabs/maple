import type { CodeReviewFinding } from "@maple/domain/http"
import {
	CATEGORY_LABELS,
	FINDING_STATUS_LABELS,
	SEVERITY_LABELS,
	SEVERITY_TONE,
} from "../../../components/code-review/code-review-format"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { listRow } from "../../../ui/list-row"
import { middleTruncate } from "../../../ui/middle-truncate"
import { panel } from "../../../ui/panel"
import * as Tooltip from "../../../ui/tooltip"
import { Message, type Model } from "./model"

// `FindingRow` under one `RelativeTime` tooltip.

type H = HtmlBuilder<Message>

/** Last path segment: kept visible when a long path middle-truncates. */
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

const timeTriggerId = (finding: CodeReviewFinding) => `code-review-finding-time-${finding.id}`

type RowContext = Readonly<{
	selected: string | undefined
	nowMs: number
	trigger: (id: string) => ReadonlyArray<ChildAttribute>
}>

const findingRow = (h: H, finding: CodeReviewFinding, context: RowContext): Html =>
	h.li(
		[h.Key(finding.id)],
		[
			listRow(h, {
				onClick: Message.ClickedFinding({ reviewId: finding.reviewId }),
				selected: finding.reviewId === context.selected,
				leading: h.span(
					[h.Class(cn("w-16 text-xs font-medium", TONE_TEXT[SEVERITY_TONE[finding.severity]]))],
					[SEVERITY_LABELS[finding.severity]],
				),
				title: finding.title,
				meta: h.span(
					[h.Class("flex min-w-0 items-center gap-1.5")],
					[
						middleTruncate(h, {
							text: `${finding.path}:${finding.line}`,
							tail: Math.min(
								40,
								Array.from(`${basename(finding.path)}:${finding.line}`).length,
							),
							mono: true,
						}),
						h.span(
							[
								h.Class("min-w-0 max-w-[45%] shrink-0 truncate"),
								h.Title(`${finding.repositoryFullName}#${finding.number}`),
							],
							["· ", finding.repositoryFullName, "#", String(finding.number)],
						),
					],
				),
				trailing: [
					h.span(
						[h.Class("hidden text-xs text-muted-foreground sm:block")],
						[CATEGORY_LABELS[finding.category]],
					),
					badge(h, { variant: "outline", size: "sm" }, [FINDING_STATUS_LABELS[finding.status]]),
					h.time(
						[
							h.Class(
								"cursor-default hidden w-20 text-right text-xs text-muted-foreground md:block",
							),
							h.DataAttribute("slot", "tooltip-trigger"),
							h.Attribute("datetime", new Date(finding.createdAt).toISOString()),
							...context.trigger(timeTriggerId(finding)),
						],
						[formatRelativeFrom(finding.createdAt, context.nowMs)],
					),
				],
			}),
		],
	)

export const findingsList = (
	h: H,
	model: Model,
	findings: ReadonlyArray<CodeReviewFinding>,
	timeZone: string,
): Html =>
	h.submodel({
		slotId: model.timeTooltip.id,
		model: model.timeTooltip,
		view: Tooltip.view,
		toParentMessage: (message: Tooltip.Message) => Message.GotTimeTooltipMessage({ message }),
		viewInputs: {
			triggerIds: findings.map(timeTriggerId),
			toContent: (triggerId) => {
				const finding = findings.find((candidate) => timeTriggerId(candidate) === triggerId)
				return finding === undefined
					? []
					: [formatTimestampInTimezone(finding.createdAt, { timeZone, withYear: true })]
			},
			toView: ({ trigger, portal }) =>
				h.div(
					[h.Class("contents")],
					[
						panel(h, {}, [
							h.ul(
								[h.Class("divide-y")],
								findings.map((finding) =>
									findingRow(h, finding, {
										selected: model.search.review,
										nowMs: model.frame.nowMs,
										trigger,
									}),
								),
							),
						]),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})
