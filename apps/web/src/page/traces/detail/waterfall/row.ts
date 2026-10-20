import { cacheResultStyles, getCacheInfo } from "@maple/ui/lib/cache"
import { getServiceColor } from "@maple/ui/lib/colors"
import { formatDuration } from "@maple/ui/lib/format"
import { getHttpInfo, HTTP_METHOD_COLORS, httpStatusTone } from "@maple/ui/lib/http"
import { getSpanKindLabel, getSpanStatusBadgeClass } from "@maple/ui/lib/span-kind"
import { spanStartMs } from "@maple/ui/lib/span-tree"
import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../../ui/display"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import { truncatedId } from "../../../../ui/truncated-id"
import { truncatedText } from "../../../../ui/truncated-text"
import { serviceDot } from "../../../../ui/values"
import type { SpanNodeData } from "../trace-data"
import { Message } from "./model"
import { rowPlatform } from "./platform"
import { countDescendants } from "./tree"

// `SpanRow` (packages/ui/src/components/traces/span-row.tsx) and `PixelDurationBar`.

// copied: `outcomeBadgeStyle(true)` (cloud-platforms/types.ts pulls in the React icon set).
const BAD_OUTCOME_STYLE = "bg-severity-error/15 text-severity-error border-severity-error/30"

const MAX_INDENT_DEPTH = 10
const TOTAL_BLOCKS = 27

export type RowContext = Readonly<{
	totalDurationMs: number
	traceStartTime: string
	isExpanded: boolean
	isSelected: boolean
}>

const depthIndent = (h: HtmlBuilder<Message>, depth: number): ReadonlyArray<Html> =>
	depth <= 0
		? []
		: [
				h.div(
					[h.Class("shrink-0"), h.Style({ width: `${Math.min(depth, MAX_INDENT_DEPTH) * 24}px` })],
					[],
				),
				...(depth > MAX_INDENT_DEPTH
					? [
							h.span(
								[
									h.Class("shrink-0 font-mono text-3xs tabular-nums text-muted-foreground"),
									h.Title(`Depth ${depth}`),
								],
								["L", String(depth)],
							),
						]
					: []),
			]

const toggle = (h: HtmlBuilder<Message>, span: SpanNodeData, isExpanded: boolean): Html =>
	span.children.length > 0
		? iconButton(
				h,
				{
					label: isExpanded ? "Collapse span" : "Expand span",
					className: "size-6 shrink-0",
					hasTooltip: false,
					attributes: [
						h.OnClick(Message.ClickedToggle({ spanId: span.spanId }), { propagation: "Stop" }),
					],
				},
				[icon(h, isExpanded ? "ChevronDownIcon" : "ChevronRightIcon")],
			)
		: h.div([h.Class("w-6 shrink-0")], [])

/** `PixelDurationBar`: fixed blocks, lit where the span covers them. */
const pixelBar = (
	h: HtmlBuilder<Message>,
	leftPercent: number,
	widthPercent: number,
	color: string,
): Html => {
	const spanEnd = leftPercent + widthPercent
	return h.div(
		[h.Class(cn("flex items-center gap-0.5 w-48", "hidden @min-[560px]/row:flex"))],
		Array.from({ length: TOTAL_BLOCKS }, (_, i) => {
			const isActive =
				((i + 1) / TOTAL_BLOCKS) * 100 > leftPercent && (i / TOTAL_BLOCKS) * 100 < spanEnd
			return h.div(
				[
					h.Attribute(
						"class",
						`w-[5px] h-2.5 rounded-[1px] shrink-0 ${isActive ? color : "bg-muted"}`,
					),
				],
				[],
			)
		}),
	)
}

const missingRow = (h: HtmlBuilder<Message>, span: SpanNodeData, ctx: RowContext): Html =>
	h.div(
		[
			h.Class(
				cn(
					"@container/row group flex items-center border-b border-dashed py-1.5 px-2 bg-muted/30",
					ctx.isSelected && "bg-primary/5 border-l-2 border-l-primary",
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2 flex-1 min-w-0 overflow-hidden")],
				[
					...depthIndent(h, span.depth),
					toggle(h, span, ctx.isExpanded),
					badge(
						h,
						{
							variant: "outline",
							className:
								"shrink-0 font-mono text-3xs px-1.5 border-dashed text-muted-foreground",
						},
						["missing"],
					),
					truncatedText(
						h,
						{
							text: `Missing span: ${span.spanId}`,
							className: "flex-1 font-mono text-xs italic text-muted-foreground",
						},
						["Missing span"],
					),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2 shrink-0 ml-2")],
				[
					h.div([h.Class("hidden w-48 @min-[560px]/row:block")], []),
					truncatedId(h, {
						value: span.spanId,
						kind: "span",
						className: "w-16 text-right text-3xs text-muted-foreground/50 truncate",
					}),
					h.div([h.Class("w-14")], []),
				],
			),
		],
	)

type HttpInfo = NonNullable<ReturnType<typeof getHttpInfo>>

const serviceLabel = (h: HtmlBuilder<Message>, span: SpanNodeData): Html => {
	const platform = rowPlatform({ ...span.spanAttributes })
	return h.span(
		[h.Class("flex min-w-0 max-w-[30%] shrink items-center gap-1.5 font-mono text-3xs")],
		[
			...(platform === null
				? []
				: [
						icon(h, platform.icon, {
							size: 11,
							className: cn("shrink-0", platform.accentClassName),
							attributes: [h.AriaLabel(platform.label)],
						}),
					]),
			serviceDot(h, { serviceName: span.serviceName, className: "size-1.5" }),
			h.span(
				[
					h.Class("min-w-0 truncate"),
					h.Style({ color: getServiceColor(span.serviceName) }),
					h.Title(span.serviceName),
				],
				[span.serviceName],
			),
			h.span([h.Class("shrink-0 text-muted-foreground/60")], [getSpanKindLabel(span.spanKind)]),
		],
	)
}

const edgeLabel = (h: HtmlBuilder<Message>, span: SpanNodeData): ReadonlyArray<Html> => {
	const platform = rowPlatform({ ...span.spanAttributes })
	return platform === null || platform.edge === null
		? []
		: [
				h.span(
					[
						h.Class(
							"hidden @min-[600px]:inline-flex items-center gap-1 shrink-0 font-mono text-3xs text-muted-foreground",
						),
						...(platform.location === null ? [] : [h.Title(platform.location)]),
					],
					[icon(h, "GlobeIcon", { size: 10, className: "shrink-0" }), platform.edge],
				),
			]
}

const nameLabel = (h: HtmlBuilder<Message>, span: SpanNodeData, httpInfo: HttpInfo | null): Html => {
	if (httpInfo === null)
		return truncatedText(h, { text: span.spanName, mono: true, className: "flex-1 text-xs" })
	const route = httpInfo.route === null || httpInfo.route === "" ? span.spanName : httpInfo.route
	return h.span(
		[h.Class("flex-1 flex items-center gap-1.5 min-w-0 font-mono text-xs"), h.Title(route)],
		[
			h.span(
				[
					h.Class(
						cn(
							"px-1 py-0.5 rounded text-3xs font-bold text-white shrink-0 leading-none hidden @min-[500px]:inline-flex",
							HTTP_METHOD_COLORS[httpInfo.method] ?? "bg-muted-foreground",
						),
					),
				],
				[httpInfo.method],
			),
			h.span([h.Class("truncate")], [route]),
		],
	)
}

/** The status cell: cache result, else the HTTP code, else the span status. */
const statusCell = (h: HtmlBuilder<Message>, span: SpanNodeData, httpInfo: HttpInfo | null): Html => {
	const cacheInfo = getCacheInfo({ ...span.spanAttributes })
	if (cacheInfo?.result === "hit" || cacheInfo?.result === "miss") {
		return badge(
			h,
			{
				variant: "outline",
				className: cn(
					"text-3xs w-14 justify-center font-medium",
					cacheResultStyles[cacheInfo.result],
				),
			},
			[cacheInfo.result === "hit" ? "HIT" : "MISS"],
		)
	}
	const code = httpInfo?.statusCode ?? null
	if (code !== null && code !== 0) {
		const tone = httpStatusTone(code)
		return h.span(
			[
				h.Class(
					cn(
						"w-14 text-center font-mono text-xs font-medium",
						tone !== "neutral"
							? TONE_TEXT[tone]
							: code >= 300
								? "text-chart-p50"
								: "text-severity-info",
					),
				),
			],
			[String(code)],
		)
	}
	return badge(
		h,
		{
			variant: "outline",
			className: cn(
				"text-3xs w-14 justify-center font-medium",
				getSpanStatusBadgeClass(span.statusCode),
			),
		},
		[span.statusCode === "" ? "Unset" : span.statusCode],
	)
}

const rightSection = (
	h: HtmlBuilder<Message>,
	span: SpanNodeData,
	ctx: RowContext,
	httpInfo: HttpInfo | null,
): Html => {
	const traceStartMs = new Date(ctx.traceStartTime).getTime()
	const leftPercent =
		ctx.totalDurationMs > 0 ? ((spanStartMs(span) - traceStartMs) / ctx.totalDurationMs) * 100 : 0
	const widthPercent = ctx.totalDurationMs > 0 ? (span.durationMs / ctx.totalDurationMs) * 100 : 0
	const httpTone = httpStatusTone(httpInfo?.statusCode)
	const barColor =
		httpTone === "crit"
			? TONE_FILL.crit
			: httpTone === "warn"
				? TONE_FILL.warn
				: span.statusCode === "Error"
					? TONE_FILL.crit
					: "bg-primary"
	const platform = rowPlatform({ ...span.spanAttributes })
	const outcome = Option.fromNullishOr(platform?.outcome).pipe(Option.filter((o) => o.bad))
	return h.div(
		[h.Class("flex items-center gap-2 shrink-0 ml-2")],
		[
			pixelBar(h, leftPercent, Math.max(widthPercent, 1), barColor),
			h.span(
				[h.Class("w-16 text-right font-mono text-xs text-muted-foreground")],
				[formatDuration(span.durationMs)],
			),
			...Option.match(outcome, {
				onNone: () => [],
				onSome: (bad) => [
					badge(
						h,
						{
							variant: "outline",
							className: cn(
								"text-3xs justify-center font-medium px-1.5 shrink-0",
								BAD_OUTCOME_STYLE,
							),
							attributes: [h.Title(`${platform?.label ?? ""} outcome`)],
						},
						[bad.value],
					),
				],
			}),
			statusCell(h, span, httpInfo),
		],
	)
}

const selectKey = (spanId: string) => (key: string) =>
	key === "Enter" || key === " " ? Option.some(Message.ClickedRow({ spanId })) : Option.none()

export const spanRow = (h: HtmlBuilder<Message>, span: SpanNodeData, ctx: RowContext): Html => {
	if (span.isMissing === true) return missingRow(h, span, ctx)
	const httpInfo = getHttpInfo({
		spanName: span.spanName,
		spanAttributes: { ...span.spanAttributes },
		spanKind: span.spanKind,
	})
	const hasChildren = span.children.length > 0
	return h.div(
		[
			h.Class(
				cn(
					"@container/row group flex items-center border-b py-1.5 hover:bg-muted/50 cursor-pointer px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					span.statusCode === "Error" && "bg-severity-error/5",
					ctx.isSelected && "bg-primary/5 border-l-2 border-l-primary",
				),
			),
			h.Role("button"),
			h.Tabindex(0),
			h.OnClick(Message.ClickedRow({ spanId: span.spanId })),
			h.OnKeyDownPreventDefault(selectKey(span.spanId)),
		],
		[
			h.div(
				[h.Class("@container flex items-center gap-2 flex-1 min-w-0 overflow-hidden")],
				[
					...depthIndent(h, span.depth),
					toggle(h, span, ctx.isExpanded),
					serviceLabel(h, span),
					...edgeLabel(h, span),
					nameLabel(h, span, httpInfo),
					...(hasChildren && !ctx.isExpanded
						? [
								h.span(
									[h.Class("shrink-0 text-3xs text-muted-foreground")],
									["+", String(countDescendants(span))],
								),
							]
						: []),
				],
			),
			rightSection(h, span, ctx, httpInfo),
		],
	)
}
