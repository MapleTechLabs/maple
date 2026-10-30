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
import { countDescendants, type TreeRow, treeLevel } from "./tree"

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

const COLUMN_PX = 24
/** Where a row's toggle sits: its column plus the row's `gap-2`, centred in the `w-6` toggle. */
const RAIL_X = 20
const RAIL = "absolute w-px bg-foreground/15"

/** The call-path tree: ancestor rails, this row's elbow, and the stem down to its first child. */
const treeGuides = (h: HtmlBuilder<Message>, row: TreeRow, isExpanded: boolean): ReadonlyArray<Html> => {
	const level = treeLevel(row)
	const shown = Math.min(level, MAX_INDENT_DEPTH)
	const hasStem = isExpanded && row.node.children.length > 0
	if (shown === 0 && !hasStem) return []
	const x = (column: number) => `${column * COLUMN_PX + RAIL_X}px`
	const isElbowShown = level > 0 && level <= MAX_INDENT_DEPTH
	return [
		h.div(
			[
				h.AriaHidden(true),
				h.Class("relative -my-1.5 shrink-0 self-stretch"),
				h.Style({ width: `${shown * COLUMN_PX}px`, "margin-right": shown === 0 ? "-8px" : "0px" }),
			],
			[
				...row.rails
					.slice(0, shown)
					.flatMap((continues, column) =>
						continues
							? [h.span([h.Class(`${RAIL} inset-y-0`), h.Style({ left: x(column) })], [])]
							: [],
					),
				...(isElbowShown
					? [
							h.span(
								[
									h.Class(cn(RAIL, "top-0", row.isLast ? "h-1/2" : "bottom-0")),
									h.Style({ left: x(level - 1) }),
								],
								[],
							),
							h.span(
								[
									h.Class("absolute top-1/2 h-px bg-foreground/15"),
									h.Style({ left: x(level - 1), width: `${COLUMN_PX - RAIL_X + 12}px` }),
								],
								[],
							),
						]
					: []),
				...(hasStem && level < MAX_INDENT_DEPTH
					? [
							h.span(
								[
									h.Class(`${RAIL} top-[calc(50%+8px)] bottom-0`),
									h.Style({ left: x(level) }),
								],
								[],
							),
						]
					: []),
			],
		),
		...(level > MAX_INDENT_DEPTH
			? [
					h.span(
						[
							h.Class("shrink-0 font-mono text-3xs tabular-nums text-muted-foreground"),
							h.Title(`Depth ${level}`),
						],
						["L", String(level)],
					),
				]
			: []),
	]
}

const statusFill = (statusCode: string): string =>
	statusCode === "Error" ? TONE_FILL.crit : statusCode === "Ok" ? TONE_FILL.ok : TONE_FILL.neutral

/** A parent's chevron, or a leaf's status square where the elbow lands. */
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
		: h.div(
				[h.Class("flex h-7 w-6 shrink-0 items-center justify-center")],
				[
					h.span(
						[
							h.Class(cn("size-2 rounded-[2px]", statusFill(span.statusCode))),
							h.Title(span.statusCode === "" ? "Unset" : span.statusCode),
						],
						[],
					),
				],
			)

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

const missingRow = (h: HtmlBuilder<Message>, row: TreeRow, ctx: RowContext): Html => {
	const span = row.node
	return h.div(
		[
			h.Class(
				cn(
					"@container/row group flex items-stretch px-2 bg-surface-sunken",
					ctx.isSelected && "bg-primary/5 shadow-[inset_2px_0_0_var(--color-primary)]",
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2 flex-1 min-w-0 overflow-hidden py-1.5")],
				[
					...treeGuides(h, row, ctx.isExpanded),
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
				[h.Class("flex items-center gap-2 shrink-0 ml-2 py-1.5")],
				[
					h.div([h.Class("hidden w-48 @min-[560px]/row:block")], []),
					truncatedId(h, {
						value: span.spanId,
						kind: "span",
						className: "w-16 text-right text-3xs text-foreground-faint truncate",
					}),
					h.div([h.Class("w-14")], []),
				],
			),
		],
	)
}

type HttpInfo = NonNullable<ReturnType<typeof getHttpInfo>>

/** The service where the call path enters it; a child in its parent's service keeps only the platform. */
const serviceLabel = (h: HtmlBuilder<Message>, row: TreeRow): ReadonlyArray<Html> => {
	const span = row.node
	const platform = rowPlatform({ ...span.spanAttributes })
	const platformIcon =
		platform === null
			? []
			: [
					icon(h, platform.icon, {
						size: 12,
						className: cn("shrink-0", platform.accentClassName),
						attributes: [h.AriaLabel(platform.label)],
					}),
				]
	if (row.parent !== null && row.parent.serviceName === span.serviceName) return platformIcon
	return [
		h.span(
			[h.Class("flex min-w-0 max-w-[30%] shrink items-center gap-1.5 font-mono text-3xs")],
			[
				...platformIcon,
				serviceDot(h, { serviceName: span.serviceName, className: "size-1.5" }),
				h.span(
					[
						h.Class("min-w-0 truncate"),
						h.Style({ color: getServiceColor(span.serviceName) }),
						h.Title(span.serviceName),
					],
					[span.serviceName],
				),
				h.span([h.Class("shrink-0 text-foreground-subtle")], [getSpanKindLabel(span.spanKind)]),
			],
		),
	]
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

// `Receiver.method(args)`: the receiver and args recede so the called method reads first.
const CALL_NAME = /^((?:[A-Za-z_$][\w$]*\.)+)([A-Za-z_$][\w$]*)(\(.*\))?$/

const nameLabel = (h: HtmlBuilder<Message>, span: SpanNodeData, httpInfo: HttpInfo | null): Html => {
	if (httpInfo === null) {
		const call = CALL_NAME.exec(span.spanName)
		if (call === null)
			return truncatedText(h, { text: span.spanName, mono: true, className: "min-w-0 text-xs" })
		const [, receiver = "", method = "", args = ""] = call
		return h.span(
			[h.Class("min-w-0 truncate font-mono text-xs"), h.Title(span.spanName)],
			[
				h.span([h.Class("text-muted-foreground")], [receiver]),
				h.span([h.Class("font-semibold text-foreground")], [method]),
				...(args === "" ? [] : [h.span([h.Class("text-muted-foreground")], [args])]),
			],
		)
	}
	const route = httpInfo.route === null || httpInfo.route === "" ? span.spanName : httpInfo.route
	return h.span(
		[h.Class("flex items-center gap-1.5 min-w-0 font-mono text-xs"), h.Title(route)],
		[
			h.span(
				[
					h.Class(
						cn(
							"px-1 py-0.5 rounded-sm text-3xs font-bold text-white shrink-0 leading-none hidden @min-[500px]:inline-flex",
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

type CodeLocation = Readonly<{ file: string; path: string; line: string }>

/** `code.file.path` / `code.line.number`, or their pre-1.30 `code.filepath` / `code.lineno`. */
const codeLocation = (span: SpanNodeData): CodeLocation | null => {
	const attrs = span.spanAttributes
	const path = attrs["code.file.path"] ?? attrs["code.filepath"] ?? ""
	if (path === "") return null
	return {
		file: path.slice(path.lastIndexOf("/") + 1),
		path,
		line: attrs["code.line.number"] ?? attrs["code.lineno"] ?? "",
	}
}

/** `file.ts:120`, or just `:120` under a parent in the same file. */
const locationLabel = (h: HtmlBuilder<Message>, row: TreeRow): ReadonlyArray<Html> => {
	const location = codeLocation(row.node)
	if (location === null) return []
	const parentPath = row.parent === null ? null : codeLocation(row.parent)?.path
	const isSameFile = parentPath === location.path && location.line !== ""
	return [
		h.span(
			[
				h.Class(
					"ml-auto hidden shrink-0 pl-2 font-mono text-3xs tabular-nums @min-[640px]/row:inline",
				),
				h.Title(location.line === "" ? location.path : `${location.path}:${location.line}`),
			],
			[
				...(isSameFile ? [] : [h.span([h.Class("text-foreground-soft")], [location.file])]),
				...(location.line === ""
					? []
					: [h.span([h.Class("text-muted-foreground")], [":", location.line])]),
			],
		),
	]
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
		[h.Class("flex items-center gap-2 shrink-0 ml-2 py-1.5")],
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

export const spanRow = (h: HtmlBuilder<Message>, row: TreeRow, ctx: RowContext): Html => {
	const span = row.node
	if (span.isMissing === true) return missingRow(h, row, ctx)
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
					"@container/row group flex items-stretch hover:bg-surface-sunken cursor-pointer px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					span.statusCode === "Error" && "bg-severity-error/5",
					ctx.isSelected && "bg-primary/5 shadow-[inset_2px_0_0_var(--color-primary)]",
				),
			),
			h.Role("button"),
			h.Tabindex(0),
			h.OnClick(Message.ClickedRow({ spanId: span.spanId })),
			h.OnKeyDownPreventDefault(selectKey(span.spanId)),
		],
		[
			h.div(
				[h.Class("@container flex items-center gap-2 flex-1 min-w-0 overflow-hidden py-1.5")],
				[
					...treeGuides(h, row, ctx.isExpanded),
					toggle(h, span, ctx.isExpanded),
					nameLabel(h, span, httpInfo),
					...serviceLabel(h, row),
					...edgeLabel(h, span),
					...(hasChildren && !ctx.isExpanded
						? [
								h.span(
									[h.Class("shrink-0 text-3xs text-muted-foreground")],
									["+", String(countDescendants(span))],
								),
							]
						: []),
					...locationLabel(h, row),
				],
			),
			rightSection(h, span, ctx, httpInfo),
		],
	)
}
