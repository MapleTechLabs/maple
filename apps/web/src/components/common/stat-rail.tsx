import * as React from "react"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { rowSelectedClass } from "@maple/ui/components/ui/list-row"
import { MiniBars } from "@maple/ui/components/ui/mini-bars"
import { SPARK_COLOR, VALUE_TONE, type Tone } from "@/components/infra/severity-tokens"

interface StatRailProps {
	children: React.ReactNode
	/** Columns at the `md` breakpoint (always 2-up below it). Defaults to 4. */
	columns?: StatRailColumns
	className?: string
	"aria-busy"?: boolean
}

type StatRailColumns = 2 | 3 | 4 | 5

const COLUMNS_CLASS: Record<StatRailColumns, string> = {
	2: "md:grid-cols-2",
	3: "md:grid-cols-3",
	4: "md:grid-cols-4",
	5: "md:grid-cols-5",
} satisfies Record<StatRailColumns, string>

export function StatRail({ children, columns = 4, className, "aria-busy": ariaBusy }: StatRailProps) {
	return (
		<div
			aria-busy={ariaBusy}
			className={cn(
				"grid grid-cols-2 divide-x divide-y divide-border rounded-md border bg-card md:divide-y-0",
				COLUMNS_CLASS[columns],
				className,
			)}
		>
			{children}
		</div>
	)
}

type StatFigureSize = "sm" | "md" | "lg"

const FIGURE_VALUE: Record<StatFigureSize, string> = {
	sm: "text-xl",
	md: "text-2xl tracking-tight",
	lg: "text-[26px] tracking-[-0.01em]",
} satisfies Record<StatFigureSize, string>

const FIGURE_UNIT: Record<StatFigureSize, string> = {
	sm: "text-2xs",
	md: "text-xs",
	lg: "text-2xs",
} satisfies Record<StatFigureSize, string>

/** A headline number with a muted unit or caption riding its baseline; never wraps. */
export function StatFigure({
	value,
	unit,
	size = "md",
	mono = true,
	className,
	valueClassName,
}: {
	value: React.ReactNode
	unit?: React.ReactNode
	size?: StatFigureSize
	/** Mono figures for readouts; `false` sets the value in the display face. */
	mono?: boolean
	className?: string
	valueClassName?: string
}) {
	return (
		<span className={cn("flex items-baseline gap-1.5 whitespace-nowrap", className)}>
			<span
				className={cn(
					"font-semibold tabular-nums leading-none",
					mono ? "font-mono" : "font-display",
					FIGURE_VALUE[size],
					valueClassName,
				)}
			>
				{value}
			</span>
			{unit ? <span className={cn("text-muted-foreground", FIGURE_UNIT[size])}>{unit}</span> : null}
		</span>
	)
}

interface StatRailItemProps {
	eyebrow: string
	/** Usually a formatted string; a node for a value with a unit or inline link. */
	value: React.ReactNode
	tone?: Tone
	delta?: React.ReactNode
	/** Top-right slot, e.g. a link out. Takes precedence over `delta`. */
	action?: React.ReactNode
	spark?: ReadonlyArray<number>
	/** Overrides the tone-derived sparkline colour (raw CSS colour). */
	sparkColor?: string
	subline?: React.ReactNode
	delay?: number
	/** Drop the reserved sparkline slot so the value spans full width (dense grids with no sparks). */
	compact?: boolean
	/**
	 * Makes the tile a button. Given it, the tile also honours `selected` and
	 * `disabled`; without it the tile stays the plain readout every other rail
	 * renders, so no existing caller changes behaviour.
	 */
	onSelect?: () => void
	/** Only meaningful alongside `onSelect`. */
	selected?: boolean
	/** A tile with nothing to show: still rendered, but not selectable. */
	disabled?: boolean
	/** Extra classes on the tile shell, e.g. container-query padding overrides. */
	className?: string
	/** Extra classes on the value, e.g. a container-query size step-down. */
	valueClassName?: string
	/** Accessible name for the selectable tile when the eyebrow alone is ambiguous. */
	ariaLabel?: string
	/** `sm` is the dense tile: tighter padding, a smaller value and no reserved spark slot. */
	size?: "md" | "sm"
	/** Muted text set inline after the value, e.g. a unit or "of 12 total". */
	hint?: React.ReactNode
}

export function StatRailItem({
	eyebrow,
	value,
	tone = "neutral",
	delta,
	action,
	spark,
	sparkColor,
	subline,
	delay,
	compact,
	onSelect,
	selected,
	disabled,
	className,
	valueClassName,
	ariaLabel,
	size = "md",
	hint,
}: StatRailItemProps) {
	const small = size === "sm"
	const body = (
		<>
			<div className="flex items-baseline justify-between gap-3">
				<span
					className={cn(
						"truncate text-2xs font-medium transition-colors",
						selected ? "text-primary" : "text-muted-foreground",
					)}
				>
					{eyebrow}
				</span>
				{action ??
					(delta ? (
						<span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground/80">
							{delta}
						</span>
					) : null)}
			</div>
			<div className={cn("flex items-end justify-between gap-3", small ? "mt-1.5" : "mt-2")}>
				{/* The value never wraps and never yields width; the sparkline gives way
				    instead. A two-line "12m 45s" pushes its whole row taller than the
				    tiles beside it, and the number is the thing the tile is for. */}
				<StatFigure
					value={value}
					unit={hint}
					size={small ? "sm" : "lg"}
					className="shrink-0"
					valueClassName={cn(VALUE_TONE[tone], valueClassName)}
				/>
				{spark && spark.length > 1 ? (
					<MiniBars
						values={spark.slice(-28)}
						color={sparkColor ?? SPARK_COLOR[tone]}
						opacityRamp
						className="h-7 w-24 min-w-0 shrink"
					/>
				) : compact || small ? null : (
					<div className="h-7 w-24 min-w-0 shrink" />
				)}
			</div>
			{subline ? (
				<div className="mt-2 truncate text-2xs text-muted-foreground">{subline}</div>
			) : null}
		</>
	)

	const shell = cn(
		"relative animate-in fade-in slide-in-from-bottom-1 duration-500",
		small ? "px-4 py-3" : "px-5 py-4",
		className,
	)
	const style = delay ? { animationDelay: `${delay}ms`, animationFillMode: "backwards" } : undefined

	if (!onSelect) {
		return (
			<div className={shell} style={style}>
				{body}
			</div>
		)
	}

	return (
		<button
			type="button"
			disabled={disabled}
			aria-pressed={selected}
			aria-label={ariaLabel}
			onClick={onSelect}
			className={cn(
				shell,
				"w-full text-left",
				rowSelectedClass(selected),
				disabled ? "cursor-default" : "cursor-pointer hover:bg-muted/25",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
			)}
			style={style}
		>
			{body}
		</button>
	)
}

/** One tile's placeholder, in the same shell as `StatRailItem`. */
export function StatRailItemSkeleton({ className }: { className?: string }) {
	return (
		<div className={cn("px-5 py-4", className)}>
			<Skeleton className="h-3 w-16" />
			<div className="mt-3 flex items-end justify-between gap-3">
				<Skeleton className="h-7 w-20" />
				<Skeleton className="h-7 w-24" />
			</div>
			<Skeleton className="mt-3 h-3 w-28" />
		</div>
	)
}

export function StatRailLoading({ count = 4, columns }: { count?: number; columns?: StatRailColumns }) {
	return (
		<StatRail columns={columns} aria-busy>
			{Array.from({ length: count }, (_, i) => (
				<StatRailItemSkeleton key={i} />
			))}
		</StatRail>
	)
}
