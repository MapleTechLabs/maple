import { DEPTH_INDENT, ROW_HEIGHT } from "@maple/ui/components/traces/trace-timeline-types"
import { getServiceColor } from "@maple/ui/lib/colors"
import { countLabel, formatDuration } from "@maple/ui/lib/format"
import { spanEventMarkers, type TimelineSpanEvent } from "@maple/ui/lib/span-event-markers"
import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { describeSpan } from "../../../../service-map/trace-flow/span-category"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import type { Bar } from "./layout"
import { Message } from "./message"

// `TraceTimelineRow` (packages/ui/src/components/traces/trace-timeline-row.tsx).
// TODO(tooltip): event-marker tooltips and the hover span tooltip are not ported (triggers only).

const MAX_INDENT_DEPTH = 12
const BAR_LEFT = "clamp(-50%, calc((var(--b0) - var(--vp0)) * var(--vpk) * 1%), 150%)"
const BAR_RIGHT = "calc(100% - clamp(-50%, calc((var(--b1) - var(--vp0)) * var(--vpk) * 1%), 150%))"

export type RowState = Readonly<{
	top: number
	isSelected: boolean
	isFocused: boolean
	isHovered: boolean
	isDimmed: boolean
	isMatched: boolean
	showService: boolean
	events: ReadonlyArray<TimelineSpanEvent> | undefined
	/** The decoration pass's output (`useRowDecorations`): clip chevrons and outside label side. */
	leftPct: number
	rightPct: number
	/** Base UI `useId`s for the event markers' tooltip triggers. */
	markerId: (index: number) => string
}>

type H = HtmlBuilder<Message>

/**
 * The bar width a span name needs inside its bar (11px mono, 6.6px a glyph, plus padding and the
 * border), rounded up to a 16px container step: under it the name draws beside the bar instead.
 */
const LABEL_FIT = [
	{ upTo: 48, inside: "@min-[48px]/bar:inline", outside: "@max-[48px]/bar:block" },
	{ upTo: 64, inside: "@min-[64px]/bar:inline", outside: "@max-[64px]/bar:block" },
	{ upTo: 80, inside: "@min-[80px]/bar:inline", outside: "@max-[80px]/bar:block" },
	{ upTo: 96, inside: "@min-[96px]/bar:inline", outside: "@max-[96px]/bar:block" },
	{ upTo: 112, inside: "@min-[112px]/bar:inline", outside: "@max-[112px]/bar:block" },
	{ upTo: 128, inside: "@min-[128px]/bar:inline", outside: "@max-[128px]/bar:block" },
	{ upTo: 144, inside: "@min-[144px]/bar:inline", outside: "@max-[144px]/bar:block" },
	{ upTo: 160, inside: "@min-[160px]/bar:inline", outside: "@max-[160px]/bar:block" },
	{ upTo: 176, inside: "@min-[176px]/bar:inline", outside: "@max-[176px]/bar:block" },
	{ upTo: 192, inside: "@min-[192px]/bar:inline", outside: "@max-[192px]/bar:block" },
	{ upTo: 208, inside: "@min-[208px]/bar:inline", outside: "@max-[208px]/bar:block" },
	{ upTo: 224, inside: "@min-[224px]/bar:inline", outside: "@max-[224px]/bar:block" },
	{ upTo: 240, inside: "@min-[240px]/bar:inline", outside: "@max-[240px]/bar:block" },
	{ upTo: 256, inside: "@min-[256px]/bar:inline", outside: "@max-[256px]/bar:block" },
	{ upTo: 272, inside: "@min-[272px]/bar:inline", outside: "@max-[272px]/bar:block" },
	{ upTo: 288, inside: "@min-[288px]/bar:inline", outside: "@max-[288px]/bar:block" },
	{ upTo: 304, inside: "@min-[304px]/bar:inline", outside: "@max-[304px]/bar:block" },
	{ upTo: 320, inside: "@min-[320px]/bar:inline", outside: "@max-[320px]/bar:block" },
	{ upTo: 336, inside: "@min-[336px]/bar:inline", outside: "@max-[336px]/bar:block" },
	{ upTo: 352, inside: "@min-[352px]/bar:inline", outside: "@max-[352px]/bar:block" },
	{ upTo: 368, inside: "@min-[368px]/bar:inline", outside: "@max-[368px]/bar:block" },
	{ upTo: 384, inside: "@min-[384px]/bar:inline", outside: "@max-[384px]/bar:block" },
	{ upTo: 400, inside: "@min-[400px]/bar:inline", outside: "@max-[400px]/bar:block" },
] as const
const labelFit = (name: string) => {
	const needed = name.length * 6.6 + 16
	return LABEL_FIT.find((step) => needed <= step.upTo) ?? LABEL_FIT[LABEL_FIT.length - 1]
}

const attr = (h: H, value: string) => h.Attribute("class", value)

const labelCell = (h: H, bar: Bar, state: RowState, durationLabel: string): Html => {
	const indentDepth = Math.min(bar.depth, MAX_INDENT_DEPTH)
	const { category, cacheInfo } = describeSpan(bar.span)
	const spanId = bar.span.spanId
	const verb = bar.isCollapsed ? "Expand" : "Collapse"
	return h.div(
		[
			attr(
				h,
				"@container/label sticky left-0 z-10 relative flex items-center gap-1 shrink-0 border-r border-border bg-inherit pr-2 text-2xs",
			),
			h.Style({ width: "var(--sidebar-w)", "padding-left": `${indentDepth * DEPTH_INDENT + 4}px` }),
		],
		[
			...Array.from({ length: indentDepth }, (_, level) =>
				h.span(
					[
						h.AriaHidden(true),
						attr(h, "absolute top-0 bottom-0 border-l border-foreground/[0.06]"),
						h.Style({ left: `${level * DEPTH_INDENT + 8}px` }),
					],
					[],
				),
			),
			h.span(
				[
					attr(h, "shrink-0"),
					h.Style({
						width: "3px",
						height: `${ROW_HEIGHT - 8}px`,
						"background-color": bar.borderColor,
					}),
				],
				[],
			),
			...(bar.depth > MAX_INDENT_DEPTH
				? [
						h.span(
							[
								attr(h, "shrink-0 font-mono text-3xs tabular-nums text-muted-foreground"),
								h.Title(`Depth ${bar.depth}`),
							],
							["L", String(bar.depth)],
						),
					]
				: []),
			bar.hasChildren
				? iconButton(
						h,
						{
							label: verb,
							size: "icon-2xs",
							// The native title carries the shortcut hint, so no tooltip trigger per row.
							hasTooltip: false,
							className: "text-muted-foreground hover:text-foreground",
							attributes: [
								h.Tabindex(-1),
								h.Title(`${verb} — ⌥ for the whole subtree`),
								h.OnClick(Message.ClickedToggleCollapse({ spanId }), { propagation: "Stop" }),
								h.DataAttribute("toggle-span", spanId),
							],
						},
						[icon(h, bar.isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon", { size: 12 })],
					)
				: h.span([attr(h, "inline-block size-4 shrink-0")], []),
			h.span(
				[attr(h, "flex shrink-0 items-center"), h.Title(category.label)],
				[
					icon(h, category.icon, {
						size: 12,
						className: bar.isError ? TONE_TEXT.crit : category.accent.text,
					}),
				],
			),
			h.span(
				[
					attr(
						h,
						cn(
							"truncate font-mono font-medium text-foreground-soft",
							bar.isError && TONE_TEXT.crit,
							bar.span.isMissing === true && "italic text-muted-foreground",
						),
					),
				],
				[bar.span.spanName],
			),
			...(state.showService
				? [
						h.span(
							[
								attr(h, "min-w-0 max-w-[40%] truncate text-3xs @max-[240px]/label:hidden"),
								h.Style({ color: getServiceColor(bar.span.serviceName) }),
							],
							[bar.span.serviceName],
						),
					]
				: []),
			...(cacheInfo?.result === undefined || cacheInfo.result === null
				? []
				: [
						h.span(
							[
								attr(
									h,
									cn(
										"text-4xs font-semibold px-1 shrink-0 uppercase",
										cacheInfo.result === "hit" ? "text-primary" : "text-chart-p50",
									),
								),
							],
							[cacheInfo.result],
						),
					]),
			...(bar.isCollapsed && bar.childCount > 0
				? [
						h.span(
							[
								attr(
									h,
									"flex items-center gap-0.5 shrink-0 text-4xs text-foreground-subtle",
								),
								h.Title(countLabel(bar.childCount, "hidden span")),
							],
							[icon(h, "UiLayersIcon", { size: 9 }), String(bar.childCount)],
						),
					]
				: []),
			h.span(
				[attr(h, "ml-auto shrink-0 pl-2 font-mono text-3xs tabular-nums text-muted-foreground")],
				[durationLabel],
			),
		],
	)
}

const eventLabel = (marker: Readonly<{ name: string; offsetLabel: string; isException: boolean }>) =>
	`${marker.isException ? "Exception" : "Event"}: ${marker.name === "" ? "(unnamed event)" : marker.name} at ${marker.offsetLabel}`

const eventMarkers = (h: H, bar: Bar, state: RowState, events: ReadonlyArray<TimelineSpanEvent>): Html =>
	h.div(
		[
			attr(h, "pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2"),
			h.Style({ height: `${ROW_HEIGHT - 8}px` }),
		],
		spanEventMarkers(events, bar.offsetStartMs, bar.span.durationMs).map((marker, index) =>
			h.span(
				[
					h.AriaLabel(eventLabel(marker)),
					// A native hover label until the marker tooltip is ported.
					h.Title(eventLabel(marker)),
					attr(
						h,
						"pointer-events-auto absolute -top-0.5 -bottom-0.5 z-[1] flex w-2 -translate-x-1/2 justify-center",
					),
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					h.DataAttribute("slot", "tooltip-trigger"),
					h.DataAttribute("span-event", ""),
					h.Id(state.markerId(index)),
					h.Style({
						left: `clamp(-10%, calc((${marker.atMs} - var(--vp0)) * var(--vpk) * 1%), 110%)`,
					}),
					h.Tabindex(0),
				],
				[
					h.span(
						[
							attr(
								h,
								cn(
									"h-full w-0.5 rounded-full",
									marker.isException ? TONE_FILL.crit : "bg-foreground/55",
								),
							),
						],
						[],
					),
				],
			),
		),
	)

const clipChevron = (h: H, bar: Bar, side: "left" | "right", isShown: boolean): Html =>
	h.span(
		[
			h.AriaHidden(true),
			attr(
				h,
				side === "left"
					? "pointer-events-none absolute left-0.5 top-1/2 hidden -translate-y-1/2 font-mono text-4xs leading-none"
					: "pointer-events-none absolute right-0.5 top-1/2 hidden -translate-y-1/2 font-mono text-4xs leading-none",
			),
			h.DataAttribute(side === "left" ? "clip-left" : "clip-right", ""),
			h.Style({ color: bar.borderColor, display: isShown ? "block" : "none" }),
		],
		[side === "left" ? "‹" : "›"],
	)

const timelineCell = (h: H, bar: Bar, state: RowState, durationLabel: string): Html => {
	const isOffscreen = state.leftPct > 100 || state.rightPct < 0
	// An outside label takes whichever side of the bar has more of the lane left.
	const isLabelLeft = state.leftPct > 100 - state.rightPct
	const fit = labelFit(bar.span.spanName)
	return h.div(
		[attr(h, "group/cell relative flex-1 min-w-0 overflow-hidden")],
		[
			h.div(
				[
					attr(
						h,
						"@container/bar absolute top-1/2 -translate-y-1/2 flex items-center whitespace-nowrap font-mono text-2xs",
					),
					h.DataAttribute("span-bar", ""),
					h.Style({
						left: BAR_LEFT,
						right: BAR_RIGHT,
						"min-width": "2px",
						height: `${ROW_HEIGHT - 8}px`,
						"background-color": bar.fill,
						"border-left": `3px solid ${bar.borderColor}`,
						"--b0": String(bar.offsetStartMs),
						"--b1": String(bar.offsetEndMs),
					}),
				],
				[
					h.div(
						[attr(h, "flex min-w-0 flex-1 items-center overflow-hidden")],
						[
							h.span(
								[attr(h, cn("hidden truncate px-1.5 text-foreground-soft", fit.inside))],
								[bar.span.spanName],
							),
							h.span(
								[
									attr(
										h,
										"ml-auto hidden shrink-0 px-1.5 text-foreground-subtle tabular-nums @min-[140px]/bar:inline",
									),
								],
								[durationLabel],
							),
						],
					),
					h.span(
						[
							attr(
								h,
								cn(
									"pointer-events-none absolute top-1/2 hidden -translate-y-1/2 whitespace-nowrap font-mono text-3xs text-muted-foreground left-full ml-[5px] data-[side=left]:left-auto data-[side=left]:right-full data-[side=left]:ml-0 data-[side=left]:mr-[5px]",
									fit.outside,
								),
							),
							h.DataAttribute("outside-label", ""),
							...(isLabelLeft ? [h.DataAttribute("side", "left")] : []),
							...(isOffscreen ? [h.Style({ visibility: "hidden" })] : []),
						],
						[h.span([attr(h, "text-foreground-soft")], [bar.span.spanName]), " · ", durationLabel],
					),
				],
			),
			...(state.events !== undefined && state.events.length > 0
				? [eventMarkers(h, bar, state, state.events)]
				: []),
			clipChevron(h, bar, "left", state.leftPct < 0),
			clipChevron(h, bar, "right", state.rightPct > 100),
		],
	)
}

export const timelineRow = (h: H, bar: Bar, state: RowState): Html => {
	const spanId = bar.span.spanId
	const durationLabel = formatDuration(bar.span.durationMs)
	return h.div(
		[
			attr(
				h,
				cn(
					"absolute left-0 right-0 flex items-stretch cursor-pointer select-none",
					"hover:bg-surface-sunken",
					state.isHovered && "bg-surface-sunken",
					state.isSelected && "bg-primary/10",
					state.isFocused && "ring-1 ring-inset ring-primary/60",
					state.isMatched && "ring-1 ring-inset ring-primary/40",
					state.isDimmed && "opacity-40",
				),
			),
			h.DataAttribute("row-id", spanId),
			h.Style({ transform: `translateY(${state.top}px)`, height: `${ROW_HEIGHT}px` }),
			h.OnClick(Message.ClickedRow({ spanId })),
			h.OnDoubleClick(Message.DoubleClickedRow({ spanId })),
			h.OnMouseEnter(Message.HoveredRow({ spanId })),
			h.OnMouseLeave(Message.HoveredRow({ spanId: null })),
		],
		[labelCell(h, bar, state, durationLabel), timelineCell(h, bar, state, durationLabel)],
	)
}
