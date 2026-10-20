import { SPARK_COLOR, VALUE_TONE } from "../../components/infra/severity-tokens"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import type { Html, HtmlBuilder } from "foldkit/html"
import { miniBars } from "../../ui/mini-bars"
import { skeleton } from "../../ui/skeleton"
import { statFigure } from "../../ui/stat-figure"

// `StatRail`, `StatRailItem`, `StatRailItemSkeleton` and `StatRailLoading`.

export type StatRailColumns = 2 | 3 | 4 | 5

const COLUMNS_CLASS = new Map<StatRailColumns, string>([
	[2, "md:grid-cols-2"],
	[3, "md:grid-cols-3"],
	[4, "md:grid-cols-4"],
	[5, "md:grid-cols-5"],
])

export const statRail = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ columns?: StatRailColumns; className?: string; isBusy?: boolean }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			...(options.isBusy === true ? [h.AriaBusy(true)] : []),
			h.Class(
				cn(
					"grid grid-cols-2 divide-x divide-y divide-border rounded-md border bg-card md:divide-y-0",
					COLUMNS_CLASS.get(options.columns ?? 4),
					options.className,
				),
			),
		],
		children,
	)

export type StatRailItemOptions<M> = Readonly<{
	eyebrow: string
	value: Html | string
	tone?: Tone
	delta?: Html | string
	action?: Html
	subline?: Html | string
	compact?: boolean
	/** The trailing `MiniBars` (last 28 values), toned like the value unless `sparkColor` says. */
	spark?: ReadonlyArray<number>
	sparkColor?: string
	/** Entry animation delay in ms (the rail staggers its tiles). */
	delay?: number
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
					[h.Class("shrink-0 font-mono text-3xs tabular-nums text-muted-foreground/80")],
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
								"truncate text-2xs font-medium transition-colors",
								isSelected ? "text-primary" : "text-muted-foreground",
							),
						),
					],
					[options.eyebrow],
				),
				...(corner === undefined ? [] : [corner]),
			],
		),
		h.div(
			[h.Class(cn("flex items-end justify-between gap-3", isSmall ? "mt-1.5" : "mt-2"))],
			[
				statFigure(h, {
					value: options.value,
					unit: options.hint,
					size: isSmall ? "sm" : "lg",
					className: "shrink-0",
					valueClassName: cn(VALUE_TONE[options.tone ?? "neutral"], options.valueClassName),
				}),
				...(options.spark !== undefined && options.spark.length > 1
					? [
							miniBars(h, {
								values: options.spark.slice(-28),
								color: options.sparkColor ?? SPARK_COLOR[options.tone ?? "neutral"],
								opacityRamp: true,
								className: "h-7 w-24 min-w-0 shrink",
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
	const shell = cn(
		"relative animate-in fade-in slide-in-from-bottom-1 duration-500",
		isSmall ? "px-4 py-3" : "px-5 py-4",
		options.className,
	)
	const delay = options.delay ?? 0
	const delayStyle =
		delay > 0 ? [h.Style({ "animation-delay": `${delay}ms`, "animation-fill-mode": "backwards" })] : []
	if (options.onSelect === undefined) return h.div([h.Class(shell), ...delayStyle], body)
	const isDisabled = options.isDisabled === true
	return h.button(
		[
			h.Type("button"),
			...(isDisabled ? [h.Disabled(true)] : []),
			...(options.isSelected === undefined ? [] : [h.AriaPressed(String(isSelected))]),
			...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
			h.OnClick(options.onSelect),
			...delayStyle,
			h.Class(
				cn(
					shell,
					"w-full text-left",
					rowSelectedClass(isSelected),
					isDisabled ? "cursor-default" : "cursor-pointer hover:bg-muted/25",
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

export const statRailLoading = <M>(h: HtmlBuilder<M>, count = 4, columns?: StatRailColumns): Html =>
	statRail(
		h,
		{ columns, isBusy: true },
		Array.from({ length: count }, () => statRailItemSkeleton(h)),
	)
