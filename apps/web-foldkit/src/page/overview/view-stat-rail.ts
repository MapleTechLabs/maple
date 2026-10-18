import { VALUE_TONE } from "@maple/web/components/infra/severity-tokens"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { skeleton } from "../../ui/skeleton"
import { statFigure } from "../../ui/stat-figure"

// `StatRail`, `StatRailItem`, `StatRailLoading` (apps/web/src/components/common/stat-rail.tsx), the
// read-only tile only: no sparkline, no selectable button.

const COLUMNS_CLASS = new Map<2 | 3 | 4 | 5, string>([
	[2, "md:grid-cols-2"],
	[3, "md:grid-cols-3"],
	[4, "md:grid-cols-4"],
	[5, "md:grid-cols-5"],
])

/** `StatRail`; four columns unless `columns` says otherwise. */
export const statRail = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	isBusy?: boolean,
	columns: 2 | 3 | 4 | 5 = 4,
	className?: string,
): Html =>
	h.div(
		[
			...(isBusy === true ? [h.AriaBusy(true)] : []),
			h.Class(
				cn(
					"grid grid-cols-2 divide-x divide-y divide-border rounded-md border bg-card md:divide-y-0",
					COLUMNS_CLASS.get(columns),
					className,
				),
			),
		],
		children,
	)

export type StatRailItemOptions = Readonly<{
	eyebrow: string
	value: string
	tone?: Tone
	/** Top-right slot; takes precedence over `delta`. */
	action?: Html
	delta?: Html
	subline?: string
	delay?: number
	compact?: boolean
	/** `sm`: tighter padding, a smaller value and no reserved spark slot. */
	size?: "md" | "sm"
	/** Extra classes on the tile shell and on the value. */
	className?: string
	valueClassName?: string
}>

export const statRailItem = <M>(h: HtmlBuilder<M>, options: StatRailItemOptions): Html => {
	const delay = options.delay ?? 0
	const isSmall = options.size === "sm"
	const corner =
		options.action ??
		(options.delta === undefined
			? undefined
			: h.span(
					[h.Class("shrink-0 font-mono text-3xs tabular-nums text-muted-foreground/80")],
					[options.delta],
				))
	return h.div(
		[
			h.Class(
				cn(
					"relative animate-in fade-in slide-in-from-bottom-1 duration-500",
					isSmall ? "px-4 py-3" : "px-5 py-4",
					options.className,
				),
			),
			...(delay > 0
				? [h.Style({ "animation-delay": `${delay}ms`, "animation-fill-mode": "backwards" })]
				: []),
		],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-3")],
				[
					h.span(
						[h.Class("truncate text-2xs font-medium transition-colors text-muted-foreground")],
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
						size: isSmall ? "sm" : "lg",
						className: "shrink-0",
						valueClassName: cn(VALUE_TONE[options.tone ?? "neutral"], options.valueClassName),
					}),
					...(options.compact === true || isSmall ? [] : [h.div([h.Class("h-7 w-24 min-w-0 shrink")])]),
				],
			),
			...(options.subline === undefined
				? []
				: [h.div([h.Class("mt-2 truncate text-2xs text-muted-foreground")], [options.subline])]),
		],
	)
}

/** `StatRailLoading`: four skeleton tiles. */
export const statRailLoading = <M>(h: HtmlBuilder<M>): Html =>
	statRail(
		h,
		Array.from({ length: 4 }, () =>
			h.div(
				[h.Class("px-5 py-4")],
				[
					skeleton(h, "h-3 w-16"),
					h.div(
						[h.Class("mt-3 flex items-end justify-between gap-3")],
						[skeleton(h, "h-7 w-20"), skeleton(h, "h-7 w-24")],
					),
					skeleton(h, "mt-3 h-3 w-28"),
				],
			),
		),
		true,
	)
