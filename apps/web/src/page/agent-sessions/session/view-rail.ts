import { formatCost, type SessionSummary } from "@maple/agent-sessions"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { meter, segmentedBar } from "../../../ui/meter"
import type { DetectedModel } from "../kit/detected-models"
import { modelLabel } from "../kit/model-label"
import { TOKEN_BUCKETS } from "../kit/token-buckets"
import type { Message } from "./message"
import {
	AGENT_TIME_FILL,
	AGENT_TIME_ICON,
	AGENT_TIME_LABEL,
	AGENT_TIME_TEXT,
	type TimeBandKind,
} from "./span-visuals"
import { sectionHeading } from "../../kit/section-heading"

// The overview rail and its time composition: where the time, cost and tokens went.

type H = HtmlBuilder<Message>

const railSection = (h: H, title: string, aside: Html | undefined, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("flex flex-col gap-3 border-border border-t pt-6 first:border-t-0 first:pt-0")],
		[
			sectionHeading(h, { variant: "eyebrow", as: "h3", title, actions: aside, className: "mb-0" }),
			...children,
		],
	)

const sharePercent = (value: number, total: number): number => (total <= 0 ? 0 : (value / total) * 100)

const clock = (h: H, label: string, value: string, className?: string): Html =>
	h.span(
		[h.Class("flex items-baseline gap-1.5")],
		[
			eyebrow(h, {}, [label]),
			h.span([h.Class(cn("font-mono font-semibold text-xs tabular-nums", className))], [value]),
		],
	)

const timeComposition = (h: H, summary: SessionSummary): Html => {
	const { segments, totalMs } = summary.agentTime
	const bands: ReadonlyArray<{ kind: TimeBandKind; ms: number }> = [
		...segments,
		...(summary.idleMs > 0 ? [{ kind: "idle" as const, ms: summary.idleMs }] : []),
	]
	const total = Math.max(
		bands.reduce((sum, band) => sum + band.ms, 0),
		1,
	)
	const legend = bands
		.map((band) => ({ ...band, percent: sharePercent(band.ms, total) }))
		.filter((band) => band.percent >= 0.5)
	return railSection(h, "Where the time went", undefined, [
		h.div(
			[h.Class("flex flex-wrap items-baseline gap-x-4 gap-y-1")],
			[
				clock(h, "Agent time", formatSessionDuration(totalMs), "text-chart-ai-inference"),
				clock(h, "Wall clock", formatSessionDuration(summary.wallClockMs)),
			],
		),
		segmentedBar(h, {
			segments: bands.map((band) => ({
				key: band.kind,
				value: band.ms,
				className: AGENT_TIME_FILL[band.kind],
			})),
			total,
			className: "h-2 w-full gap-px rounded-xs bg-muted",
		}),
		...legend.map((band) =>
			h.div(
				[h.Key(band.kind), h.Class("flex items-center gap-2.5")],
				[
					icon(h, AGENT_TIME_ICON[band.kind], {
						size: 13,
						className: cn("shrink-0", AGENT_TIME_TEXT[band.kind]),
						attributes: [h.AriaHidden(true)],
					}),
					h.span([h.Class("min-w-0 flex-1 truncate text-xs")], [AGENT_TIME_LABEL[band.kind]]),
					h.span(
						[h.Class("font-mono text-muted-foreground text-xs tabular-nums")],
						[formatSessionDuration(band.ms), " · ", formatPercent(band.percent / 100)],
					),
				],
			),
		),
	])
}

const costSection = (h: H, summary: SessionSummary, detect: (model: string) => DetectedModel): Html => {
	const topModelCost = Math.max(...summary.models.map((model) => model.cost ?? 0), 0)
	return railSection(
		h,
		"Cost by model",
		summary.cost === undefined
			? undefined
			: h.span([h.Class("font-mono text-primary text-xs")], [formatCost(summary.cost)]),
		[
			...(summary.models.length === 0
				? [h.p([h.Class("text-muted-foreground text-xs")], ["no model calls"])]
				: summary.models.map((model) =>
						h.div(
							[h.Key(model.model), h.Class("space-y-1.5")],
							[
								h.div(
									[h.Class("flex items-baseline justify-between gap-2")],
									[
										modelLabel(h, {
											detected: detect(model.model),
											size: 12,
											className: "text-xs",
										}),
										h.span(
											[h.Class("shrink-0 font-mono text-muted-foreground text-xs")],
											[
												model.cost === undefined ? "no cost" : formatCost(model.cost),
												" ·",
												" ",
												String(model.llmCalls),
												" ",
												model.llmCalls === 1 ? "call" : "calls",
											],
										),
									],
								),
								...(model.cost !== undefined && topModelCost > 0
									? [
											meter(h, {
												value: model.cost,
												max: topModelCost,
												minVisible: 0,
												fillClassName: "bg-primary",
												className: "w-full rounded-xs bg-muted",
											}),
										]
									: []),
							],
						),
					)),
			h.p(
				[h.Class("font-prose text-2xs text-muted-foreground leading-relaxed")],
				[
					summary.cost === undefined
						? "No span reported a cost. Maple does not price tokens itself."
						: "As reported by the instrumentation. Not a bill.",
				],
			),
		],
	)
}

const tokensSection = (h: H, summary: SessionSummary): Html => {
	const buckets = TOKEN_BUCKETS.filter((bucket) => summary.tokens[bucket.key] > 0)
	return railSection(
		h,
		"Tokens",
		summary.tokens.total > 0
			? h.span([h.Class("font-mono text-xs")], [formatNumber(summary.tokens.total)])
			: undefined,
		summary.tokens.total === 0
			? [h.p([h.Class("text-muted-foreground text-xs")], ["no token usage reported"])]
			: [
					segmentedBar(h, {
						segments: buckets.map((bucket) => ({
							key: bucket.key,
							value: summary.tokens[bucket.key],
							className: bucket.fill,
						})),
						total: summary.tokens.total,
						className: "h-2 w-full gap-px rounded-xs bg-muted",
					}),
					...buckets.map((bucket) =>
						h.div(
							[h.Key(bucket.key), h.Class("flex items-center gap-2.5")],
							[
								icon(h, bucket.icon, {
									size: 13,
									className: cn("shrink-0", bucket.text),
									attributes: [h.AriaHidden(true)],
								}),
								h.span([h.Class("min-w-0 flex-1 truncate text-xs")], [bucket.label]),
								h.span(
									[h.Class("font-mono text-muted-foreground text-xs tabular-nums")],
									[formatNumber(summary.tokens[bucket.key])],
								),
							],
						),
					),
					...(summary.tokenReporting === "session-level"
						? [
								h.p(
									[h.Class("text-2xs text-muted-foreground")],
									["Reported once for the whole session"],
								),
							]
						: []),
				],
	)
}

const agentsSection = (h: H, summary: SessionSummary): Html =>
	railSection(h, "Agents", undefined, [
		h.div(
			[h.Class("flex flex-wrap items-center gap-2")],
			summary.agentNames.map((name, index) =>
				h.span(
					[h.Key(name), h.Class("flex min-w-0 max-w-full items-center gap-2")],
					[
						...(index > 0
							? [
									icon(h, "ArrowRightIcon", {
										size: 12,
										className: "shrink-0 text-muted-foreground",
									}),
								]
							: []),
						h.span(
							[
								h.Class(
									cn(
										"min-w-0 truncate rounded-sm px-2 py-0.5 font-mono text-2xs",
										index === 0
											? "bg-primary/12 text-primary"
											: "bg-muted text-muted-foreground",
									),
								),
								h.Title(name),
							],
							[name],
						),
					],
				),
			),
		),
	])

export const rail = (h: H, summary: SessionSummary, detect: (model: string) => DetectedModel): Html =>
	h.aside(
		[h.Class("flex shrink-0 flex-col gap-6 @4xl:w-[21rem] @4xl:border-border @4xl:border-l @4xl:pl-8")],
		[
			timeComposition(h, summary),
			costSection(h, summary, detect),
			tokensSection(h, summary),
			...(summary.agentNames.length > 0 ? [agentsSection(h, summary)] : []),
		],
	)
