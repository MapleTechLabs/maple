import type { CodeReviewFinding } from "@maple/domain/http"
import {
	CATEGORY_LABELS,
	FINDING_STATUS_LABELS,
	SEVERITY_LABELS,
	SEVERITY_TONE,
} from "../../../components/code-review/code-review-format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { listRow } from "@maple/views/ui/list-row"
import { middleTruncate } from "@maple/views/ui/middle-truncate"
import { panel } from "@maple/views/ui/panel"
import { relativeTime } from "../../kit/relative-time"
import { Message, type Model } from "./model"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str, Option } from "effect"

// `FindingRow` and the findings list.

type H = HtmlBuilder<Message>

/** Last path segment: kept visible when a long path middle-truncates. */
const basename = (path: string) =>
	Str.slice(Option.match(Str.lastIndexOf("/")(path), { onNone: () => 0, onSome: (slash) => slash + 1 }))(
		path,
	)

type RowContext = Readonly<{
	selected: string | undefined
	nowMs: number
	timeZone: string
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
				meta: hstack(h, { gap: "1.5", shrink: true, as: "span" }, [
					middleTruncate(h, {
						text: `${finding.path}:${finding.line}`,
						tail: Math.min(40, Array.from(`${basename(finding.path)}:${finding.line}`).length),
						mono: true,
					}),
					h.span(
						[
							h.Class("min-w-0 max-w-[45%] shrink-0 truncate"),
							h.Title(`${finding.repositoryFullName}#${finding.number}`),
						],
						["· ", finding.repositoryFullName, "#", String(finding.number)],
					),
				]),
				trailing: [
					h.span(
						[h.Class("hidden text-xs text-muted-foreground sm:block")],
						[CATEGORY_LABELS[finding.category]],
					),
					badge(h, { variant: "outline", size: "sm" }, [FINDING_STATUS_LABELS[finding.status]]),
					relativeTime(h, {
						value: finding.createdAt,
						nowMs: context.nowMs,
						timeZone: context.timeZone,
						className: "hidden w-20 text-right text-xs text-muted-foreground md:block",
					}),
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
	panel(h, {}, [
		h.ul(
			[h.Class("divide-y")],
			Arr.map(findings, (finding) =>
				findingRow(h, finding, {
					selected: model.search.review,
					nowMs: model.frame.nowMs,
					timeZone,
				}),
			),
		),
	])
