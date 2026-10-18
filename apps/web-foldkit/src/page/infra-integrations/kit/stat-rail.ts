import { SPARK_COLOR, VALUE_TONE } from "@maple/web/components/infra/severity-tokens"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { miniBars } from "../../../ui/mini-bars"
import { skeleton } from "../../../ui/skeleton"
import { statFigure } from "../../../ui/stat-figure"

// `StatRail`, `StatRailItem` and `StatRailItemSkeleton` (apps/web/src/components/common/stat-rail.tsx).

type Columns = 2 | 3 | 4 | 5

const COLUMNS_CLASS = new Map<Columns, string>([
	[2, "md:grid-cols-2"],
	[3, "md:grid-cols-3"],
	[4, "md:grid-cols-4"],
	[5, "md:grid-cols-5"],
])

export const statRail = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ columns?: Columns; className?: string; isBusy?: boolean }>,
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
	spark?: ReadonlyArray<number>
	sparkColor?: string
	subline?: Html | string
	delay?: number
	compact?: boolean
	/** Makes the tile a button, which then honours `selected` and `disabled`. */
	onSelect?: M
	selected?: boolean
	disabled?: boolean
	className?: string
	valueClassName?: string
	ariaLabel?: string
	size?: "md" | "sm"
	hint?: Html | string
}>

const body = <M>(h: HtmlBuilder<M>, options: StatRailItemOptions<M>): ReadonlyArray<Html> => {
	const small = options.size === "sm"
	const corner =
		options.action ??
		(options.delta === undefined || options.delta === ""
			? undefined
			: h.span([h.Class("shrink-0 font-mono text-3xs tabular-nums text-muted-foreground/80")], [options.delta]))
	const spark = options.spark
	return [
		h.div(
			[h.Class("flex items-baseline justify-between gap-3")],
			[
				h.span(
					[
						h.Class(
							cn(
								"truncate text-2xs font-medium transition-colors",
								options.selected === true ? "text-primary" : "text-muted-foreground",
							),
						),
					],
					[options.eyebrow],
				),
				...(corner === undefined ? [] : [corner]),
			],
		),
		h.div(
			[h.Class(cn("flex items-end justify-between gap-3", small ? "mt-1.5" : "mt-2"))],
			[
				statFigure(h, {
					value: options.value,
					unit: options.hint,
					size: small ? "sm" : "lg",
					className: "shrink-0",
					valueClassName: cn(VALUE_TONE[options.tone ?? "neutral"], options.valueClassName),
				}),
				...(spark !== undefined && spark.length > 1
					? [
							miniBars(h, {
								values: spark.slice(-28),
								color: options.sparkColor ?? SPARK_COLOR[options.tone ?? "neutral"],
								opacityRamp: true,
								className: "h-7 w-24 min-w-0 shrink",
							}),
						]
					: options.compact === true || small
						? []
						: [h.div([h.Class("h-7 w-24 min-w-0 shrink")])]),
			],
		),
		...(options.subline === undefined || options.subline === ""
			? []
			: [h.div([h.Class("mt-2 truncate text-2xs text-muted-foreground")], [options.subline])]),
	]
}

export const statRailItem = <M>(h: HtmlBuilder<M>, options: StatRailItemOptions<M>): Html => {
	const shell = cn(
		"relative animate-in fade-in slide-in-from-bottom-1 duration-500",
		options.size === "sm" ? "px-4 py-3" : "px-5 py-4",
		options.className,
	)
	const delay = options.delay ?? 0
	const style =
		delay > 0 ? [h.Style({ "animation-delay": `${delay}ms`, "animation-fill-mode": "backwards" })] : []
	if (options.onSelect === undefined) return h.div([h.Class(shell), ...style], body(h, options))
	const isDisabled = options.disabled === true
	return h.button(
		[
			h.Type("button"),
			...(isDisabled ? [h.Disabled(true)] : []),
			...(options.selected === undefined ? [] : [h.AriaPressed(String(options.selected))]),
			...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
			h.OnClick(options.onSelect),
			h.Class(
				cn(
					shell,
					"w-full text-left",
					rowSelectedClass(options.selected),
					isDisabled ? "cursor-default" : "cursor-pointer hover:bg-muted/25",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				),
			),
			...style,
		],
		body(h, options),
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
