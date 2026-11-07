import { TONE_TEXT } from "@maple/ui/lib/tone"
import { formatClockInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { timestamp } from "@maple/views/ui/timestamp"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { type AttentionItem, MAX_ATTENTION_ITEMS, needsAttention } from "./attention"
import type { HealthStrip } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { panelEmpty, panelError, panelMeta, rowsLoading, sectionPanel } from "../panel"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// "Needs attention": advisors, recurring error logs and saturation, one list.

type H = HtmlBuilder<Message>

const itemRow = (h: H, item: AttentionItem, timeZone: string): Html =>
	vstack(
		h,
		{
			gap: "1",
			as: "li",
			className: "border-t border-border-subtle px-4 py-3 first:border-t-0",
			attributes: [h.Key(item.key)],
		},
		[
			eyebrow(h, { className: TONE_TEXT[item.tone] }, [item.label]),
			h.span([h.Class("line-clamp-2 text-xs text-foreground [overflow-wrap:anywhere]")], [item.title]),
			typography(
				h,
				{ size: "2xs", tone: "muted", className: "line-clamp-1", attributes: [h.Title(item.detail)] },
				item.lastSeen === null
					? [item.detail]
					: [
							`${item.detail} · last `,
							timestamp(h, {
								value: item.lastSeen,
								timeZone,
								label: Str.slice(0, 5)(formatClockInTimezone(item.lastSeen, { timeZone })),
							}),
						],
			),
		],
	)

const settled = <A, E>(data: AsyncData.AsyncData<A, E>): boolean =>
	!AsyncData.isIdle(data) && !AsyncData.isLoading(data)

const failureOf = <A, E>(data: AsyncData.AsyncData<A, E>): E | null =>
	Option.getOrNull(AsyncData.getError(data))

export const attentionPanel = (h: H, model: Model, strip: HealthStrip | null, timeZone: string): Html => {
	const isSettled = settled(model.insights.data) && settled(model.issues.data)
	const items = needsAttention({
		insights: Option.getOrNull(AsyncData.getData(model.insights.data)),
		issues: Option.match(AsyncData.getData(model.issues.data), {
			onNone: () => [],
			onSome: (response) => response.issues,
		}),
		connections: strip === null ? null : { peak: strip.connections.peak, limit: strip.connections.limit },
	})
	const insightsFailure = failureOf(model.insights.data)
	const issuesFailure = failureOf(model.issues.data)
	const failures = [
		...(insightsFailure === null
			? []
			: [
					panelError(
						h,
						insightsFailure,
						"Couldn't load advisors",
						Message.ClickedRetry({ section: "insights" }),
					),
				]),
		...(issuesFailure === null
			? []
			: [
					panelError(
						h,
						issuesFailure,
						"Couldn't load log issues",
						Message.ClickedRetry({ section: "issues" }),
					),
				]),
	]
	return sectionPanel(
		h,
		{
			title: "Needs attention",
			action: isSettled && items.length > 0 ? panelMeta(h, `${items.length} open`) : undefined,
		},
		!isSettled
			? [rowsLoading(h, 4)]
			: [
					...failures,
					// After a failed read "nothing" is unknown, so the failure banner stands alone.
					...(items.length > 0
						? [
								h.ul(
									[h.AriaLabel("Needs attention")],
									Arr.map(items.slice(0, MAX_ATTENTION_ITEMS), (item) =>
										itemRow(h, item, timeZone),
									),
								),
							]
						: failures.length > 0
							? []
							: [panelEmpty(h, ["Nothing needs attention"])]),
				],
	)
}
