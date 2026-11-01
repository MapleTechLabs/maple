import { TONE_TEXT } from "@maple/ui/lib/tone"
import { formatClockInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../../ui/eyebrow"
import { type AttentionItem, MAX_ATTENTION_ITEMS, needsAttention } from "./attention"
import type { HealthStrip } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { panelEmpty, panelError, panelMeta, rowsLoading, sectionPanel } from "../panel"

// "Needs attention": advisors, recurring error logs and saturation, one list.

type H = HtmlBuilder<Message>

const itemRow = (h: H, item: AttentionItem, timeZone: string): Html =>
	h.li(
		[
			h.Key(item.key),
			h.Class("flex flex-col gap-1 border-t border-border-subtle px-4 py-3 first:border-t-0"),
		],
		[
			eyebrow(h, { className: TONE_TEXT[item.tone] }, [item.label]),
			h.span([h.Class("line-clamp-2 text-xs text-foreground [overflow-wrap:anywhere]")], [item.title]),
			h.span(
				[h.Class("line-clamp-1 text-2xs text-muted-foreground"), h.Title(item.detail)],
				[
					item.lastSeen === null
						? item.detail
						: `${item.detail} · last ${formatClockInTimezone(item.lastSeen, { timeZone }).slice(0, 5)}`,
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
									items
										.slice(0, MAX_ATTENTION_ITEMS)
										.map((item) => itemRow(h, item, timeZone)),
								),
							]
						: failures.length > 0
							? []
							: [panelEmpty(h, ["Nothing needs attention."])]),
				],
	)
}
