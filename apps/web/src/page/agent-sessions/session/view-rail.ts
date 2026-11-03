import { formatCost, type SessionSummary } from "@maple/agent-sessions"
import { formatNumber, formatPercent, pluralize } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { meter, segmentedBar } from "@maple/views/ui/meter"
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
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
	hstack(h, { gap: "1.5", align: "baseline", as: "span" }, [
		eyebrow(h, {}, [label]),
		h.span([h.Class(cn("font-mono font-semibold text-xs tabular-nums", className))], [value]),
	])

const timeComposition = (h: H, summary: SessionSummary): Html => {
	const { segments, totalMs } = summary.agentTime
	const bands: ReadonlyArray<{ kind: TimeBandKind; ms: number }> = [
		...segments,
		...(summary.idleMs > 0 ? [{ kind: "idle" as const, ms: summary.idleMs }] : []),
	]
	const total = Math.max(
		Arr.reduce(bands, 0, (sum, band) => sum + band.ms),
		1,
	)
	const legend = Arr.filter(
		Arr.map(bands, (band) => ({ ...band, percent: sharePercent(band.ms, total) })),
		(band) => band.percent >= 0.5,
	)
	return railSection(h, "Where the time went", undefined, [
		hstack(h, { align: "baseline", wrap: true, className: "gap-x-4 gap-y-1" }, [
			clock(h, "Agent time", formatSessionDuration(totalMs), "text-chart-ai-inference"),
			clock(h, "Wall clock", formatSessionDuration(summary.wallClockMs)),
		]),
		segmentedBar(h, {
			segments: Arr.map(bands, (band) => ({
				key: band.kind,
				value: band.ms,
				className: AGENT_TIME_FILL[band.kind],
			})),
			total,
			className: "h-2 w-full gap-px rounded-xs bg-muted",
		}),
		...Arr.map(legend, (band) =>
			hstack(h, { gap: "2.5", attributes: [h.Key(band.kind)] }, [
				icon(h, AGENT_TIME_ICON[band.kind], {
					size: 14,
					className: cn("shrink-0", AGENT_TIME_TEXT[band.kind]),
					attributes: [h.AriaHidden(true)],
				}),
				h.span([h.Class("min-w-0 flex-1 truncate text-xs")], [AGENT_TIME_LABEL[band.kind]]),
				typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
					formatSessionDuration(band.ms),
					" · ",
					formatPercent(band.percent / 100),
				]),
			]),
		),
	])
}

const costSection = (h: H, summary: SessionSummary, detect: (model: string) => DetectedModel): Html => {
	const topModelCost = Math.max(...Arr.map(summary.models, (model) => model.cost ?? 0), 0)
	return railSection(
		h,
		"Cost by model",
		summary.cost === undefined
			? undefined
			: h.span([h.Class("font-mono text-primary text-xs")], [formatCost(summary.cost)]),
		[
			...(summary.models.length === 0
				? [typography(h, { size: "xs", tone: "muted", as: "p" }, ["no model calls"])]
				: Arr.map(summary.models, (model) =>
						h.div(
							[h.Key(model.model), h.Class("space-y-1.5")],
							[
								hstack(h, { gap: "2", align: "baseline", justify: "between" }, [
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
											pluralize(model.llmCalls, "call"),
										],
									),
								]),
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
	const buckets = Arr.filter(TOKEN_BUCKETS, (bucket) => summary.tokens[bucket.key] > 0)
	return railSection(
		h,
		"Tokens",
		summary.tokens.total > 0
			? typography(h, { size: "xs", mono: true }, [formatNumber(summary.tokens.total)])
			: undefined,
		summary.tokens.total === 0
			? [typography(h, { size: "xs", tone: "muted", as: "p" }, ["no token usage reported"])]
			: [
					segmentedBar(h, {
						segments: Arr.map(buckets, (bucket) => ({
							key: bucket.key,
							value: summary.tokens[bucket.key],
							className: bucket.fill,
						})),
						total: summary.tokens.total,
						className: "h-2 w-full gap-px rounded-xs bg-muted",
					}),
					...Arr.map(buckets, (bucket) =>
						hstack(h, { gap: "2.5", attributes: [h.Key(bucket.key)] }, [
							icon(h, bucket.icon, {
								size: 14,
								className: cn("shrink-0", bucket.text),
								attributes: [h.AriaHidden(true)],
							}),
							h.span([h.Class("min-w-0 flex-1 truncate text-xs")], [bucket.label]),
							typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
								formatNumber(summary.tokens[bucket.key]),
							]),
						]),
					),
					...(summary.tokenReporting === "session-level"
						? [
								typography(h, { size: "2xs", tone: "muted", as: "p" }, [
									"Reported once for the whole session",
								]),
							]
						: []),
				],
	)
}

const agentsSection = (h: H, summary: SessionSummary): Html =>
	railSection(h, "Agents", undefined, [
		hstack(
			h,
			{ gap: "2", wrap: true },
			Arr.map(summary.agentNames, (name, index) =>
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
											? "bg-primary-a2 text-primary"
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
