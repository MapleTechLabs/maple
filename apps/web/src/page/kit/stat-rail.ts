import { SPARK_COLOR, VALUE_TONE } from "./severity-tokens"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/views/ui/list-row.styles"
import type { Html, HtmlBuilder } from "foldkit/html"
import { miniBars } from "@maple/views/ui/mini-bars"
import { skeleton } from "@maple/views/ui/skeleton"
import { statFigure } from "@maple/views/ui/stat-figure"
import { infoHint } from "@maple/views/ui/info-hint"

// A rail of stat tiles (label, value, delta, spark) and its loading skeletons.

export type StatRailColumns = 2 | 3 | 4 | 5

const COLUMNS_CLASS = new Map<StatRailColumns, string>([
	[2, "md:grid-cols-2"],
	[3, "md:grid-cols-3"],
	[4, "md:grid-cols-4"],
	[5, "md:grid-cols-5"],
])

export const statRail = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		columns?: StatRailColumns
		className?: string
		isBusy?: boolean
		/** Edge to edge under a page header: square, ruled below only, like the hub's metric strip. */
		isFlush?: boolean
	}>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			...(options.isBusy === true ? [h.AriaBusy(true)] : []),
			h.Class(
				cn(
					"grid grid-cols-2 divide-x divide-y divide-border md:divide-y-0",
					options.isFlush === true ? "border-b border-border" : "rounded-md border bg-card",
					COLUMNS_CLASS.get(options.columns ?? 4),
					options.className,
				),
			),
		],
		children,
	)

/**
 * `statRail`'s grid for a page with a filter rail: two or four columns by the page's width, not
 * the viewport's. `divide-*` would double the outer border at row ends, so each tile rules its
 * own inner right and top edges per column count. Its tiles take `METRIC_TILE`.
 */
export const metricGrid = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isBusy?: boolean }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			...(options.isBusy === true ? [h.AriaBusy(true)] : []),
			h.Class(
				cn(
					"grid grid-cols-2 overflow-hidden rounded-md border bg-card @min-[880px]/page:grid-cols-4",
					"[&>*]:border-border [&>*:nth-child(odd)]:border-r @min-[880px]/page:[&>*:not(:nth-child(4n))]:border-r",
					"@max-[879px]/page:[&>*:nth-child(n+3)]:border-t @min-[880px]/page:[&>*:nth-child(n+5)]:border-t",
				),
			),
		],
		children,
	)

/** A `metricGrid` tile's narrow-page padding and value size, spread into `statRailItem`. */
export const METRIC_TILE = {
	className: "@max-[560px]/page:px-4 @max-[560px]/page:py-3",
	valueClassName: "@max-[560px]/page:text-xl",
} as const

export type StatRailItemOptions<M> = Readonly<{
	eyebrow: string
	/** What the eyebrow means: a question mark beside it that explains it on hover (`infoHint`). */
	eyebrowTooltip?: string
	value: Html | string
	tone?: Tone
	delta?: Html | string
	action?: Html
	subline?: Html | string
	compact?: boolean
	/** The trailing mini bars (last 28 values), toned like the value unless `sparkColor` says. */
	spark?: ReadonlyArray<number>
	sparkColor?: string
	/** Makes the tile a button, which then honours `isSelected` and `isDisabled`. */
	onSelect?: M
	isSelected?: boolean
	isDisabled?: boolean
	className?: string
	valueClassName?: string
	ariaLabel?: string
	size?: "md" | "sm"
	hint?: Html | string
}>

export const statRailItem = <M>(h: HtmlBuilder<M>, options: StatRailItemOptions<M>): Html => {
	const isSmall = options.size === "sm"
	const isSelected = options.isSelected === true
	const corner =
		options.action ??
		(options.delta === undefined || options.delta === ""
			? undefined
			: h.span(
					[h.Class("shrink-0 font-mono text-3xs tabular-nums text-foreground-subtle")],
					[options.delta],
				))
	const body = [
		h.div(
			[h.Class("flex items-baseline justify-between gap-3")],
			[
				h.span(
					[
						h.Class(
							cn(
								"truncate text-2xs font-medium",
								isSelected ? "text-primary" : "text-muted-foreground",
							),
						),
					],
					[options.eyebrow],
				),
				...(options.eyebrowTooltip === undefined ? [] : [infoHint(h, options.eyebrowTooltip)]),
				...(corner === undefined ? [] : [h.span([h.Class("shrink-0 whitespace-nowrap")], [corner])]),
			],
		),
		h.div(
			[h.Class(cn("flex items-end justify-between gap-3", isSmall ? "mt-1.5" : "mt-2"))],
			[
				statFigure(h, {
					value: options.value,
					unit: options.hint,
					size: isSmall ? "sm" : "lg",
					// A long value steps down a size on phones, and its unit wraps under it.
					className: "min-w-0 flex-wrap",
					valueClassName: cn(
						VALUE_TONE[options.tone ?? "neutral"],
						!isSmall && "max-sm:text-xl",
						options.valueClassName,
					),
				}),
				...(options.spark !== undefined && options.spark.length > 1
					? [
							miniBars(h, {
								values: options.spark.slice(-28),
								color: options.sparkColor ?? SPARK_COLOR[options.tone ?? "neutral"],
								opacityRamp: true,
								className: "hidden h-7 w-24 min-w-0 shrink @min-[14rem]/stat:block",
							}),
						]
					: options.compact === true || isSmall
						? []
						: [h.div([h.Class("h-7 w-24 min-w-0 shrink")])]),
			],
		),
		...(options.subline === undefined || options.subline === ""
			? []
			: [h.div([h.Class("mt-2 truncate text-2xs text-muted-foreground")], [options.subline])]),
	]
	// No entry animation: tiles remount on every refetch and tab switch, so it would replay each time.
	const shell = cn("@container/stat relative", isSmall ? "px-4 py-3" : "px-5 py-4", options.className)
	if (options.onSelect === undefined) return h.div([h.Class(shell)], body)
	const isDisabled = options.isDisabled === true
	return h.button(
		[
			h.Type("button"),
			...(isDisabled ? [h.Disabled(true)] : []),
			...(options.isSelected === undefined ? [] : [h.AriaPressed(String(isSelected))]),
			...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
			h.OnClick(options.onSelect),
			h.Class(
				cn(
					shell,
					"w-full text-left",
					rowSelectedClass(isSelected),
					isDisabled
						? "cursor-default"
						: "cursor-pointer hover:bg-surface-faint active:bg-surface-faint",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				),
			),
		],
		body,
	)
}

export const statRailItemSkeleton = <M>(h: HtmlBuilder<M>, className?: string): Html =>
	h.div(
		[h.Class(cn("px-5 py-4", className))],
		[
			skeleton(h, "h-3 w-16"),
			h.div(
				[h.Class("mt-3 flex items-end justify-between gap-3")],
				[skeleton(h, "h-7 w-20"), skeleton(h, "h-7 w-24")],
			),
			skeleton(h, "mt-3 h-3 w-28"),
		],
	)

export const statRailLoading = <M>(
	h: HtmlBuilder<M>,
	count = 4,
	columns?: StatRailColumns,
	className?: string,
): Html =>
	statRail(
		h,
		{ columns, className, isBusy: true },
		Array.from({ length: count }, () => statRailItemSkeleton(h)),
	)
