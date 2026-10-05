// Shared cell + header primitives for the service detail tables (Operations,
// API, Dependencies). Extracted when the API tab became the third table with
// the same distribution-bar treatment — a copy per tab is how the three drift.

import { cn } from "@maple/ui/lib/utils"
import { TableCell, TableHead } from "@maple/ui/components/ui/table"
import { Eyebrow, eyebrowVariants } from "@maple/ui/components/ui/eyebrow"
import { ChevronDownIcon, ChevronUpIcon, ChevronExpandYIcon } from "@/components/icons"

export type SortDir = "asc" | "desc"

export function formatRate(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	if (value >= 1) return value.toFixed(1)
	return value.toFixed(2)
}

export function formatErrorRate(rate: number): string {
	if (rate >= 0.01) return `${(rate * 100).toFixed(1)}%`
	if (rate > 0) return "<1%"
	return "0%"
}

export function errorTone(rate: number): "error" | "warn" | "default" {
	if (rate > 0.05) return "error"
	if (rate > 0.01) return "warn"
	return "default"
}

interface BarCellProps {
	value: number
	max: number
	tone: "calls" | "errors" | "latency"
	children: React.ReactNode
}

/** Numeric cell with a column-tinted distribution bar. */
export function BarCell({ value, max, tone, children }: BarCellProps) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
	const hasBar = pct > 0
	return (
		<TableCell className="relative py-2 text-right align-middle">
			{hasBar ? (
				<div
					aria-hidden
					className={cn(
						"pointer-events-none absolute inset-y-1.5 right-2 rounded-sm opacity-50 transition-opacity group-hover/row:opacity-90",
						tone === "calls" && "bg-severity-info/20",
						tone === "errors" && "bg-severity-error/25",
						tone === "latency" && "bg-severity-warn/20",
					)}
					style={{ width: `calc(${pct}% - 0.5rem)` }}
				/>
			) : null}
			<span className="relative pr-1.5">{children}</span>
		</TableCell>
	)
}

interface SortableHeadProps {
	label: string
	align?: "left" | "right"
	active: boolean
	dir: SortDir
	onClick: () => void
	className?: string
}

export function SortableHead({ label, align = "left", active, dir, onClick, className }: SortableHeadProps) {
	const Icon = active ? (dir === "desc" ? ChevronDownIcon : ChevronUpIcon) : ChevronExpandYIcon
	return (
		<TableHead
			onClick={onClick}
			className={cn(
				eyebrowVariants(),
				"h-8 cursor-pointer select-none transition-colors",
				active ? "text-foreground" : "hover:text-foreground",
				align === "right" && "text-right",
				className,
			)}
		>
			<span className={cn("inline-flex items-center gap-1", align === "right" && "justify-end w-full")}>
				{label}
				<Icon size={11} className={active ? "text-foreground" : "text-muted-foreground/30"} />
			</span>
		</TableHead>
	)
}

/** Non-sortable column header, styled to match `SortableHead`. */
export function HeadLabel({ className, ...props }: React.ComponentProps<"th">) {
	return <TableHead className={cn(eyebrowVariants(), "h-8", className)} {...props} />
}

interface MobileSortBarProps<K extends string> {
	options: ReadonlyArray<readonly [K, string]>
	sortKey: K
	sortDir: SortDir
	onSort: (key: K) => void
}

/** Compact sort pills shown above the mobile list, where the sortable table header is hidden. */
export function MobileSortBar<K extends string>({
	options,
	sortKey,
	sortDir,
	onSort,
}: MobileSortBarProps<K>) {
	return (
		<div className="flex items-center gap-1.5 text-[11px]">
			<Eyebrow variant="label">Sort</Eyebrow>
			{options.map(([key, label]) => {
				const active = sortKey === key
				const Icon = active
					? sortDir === "desc"
						? ChevronDownIcon
						: ChevronUpIcon
					: ChevronExpandYIcon
				return (
					<button
						key={key}
						type="button"
						onClick={() => onSort(key)}
						className={cn(
							"inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono transition-colors",
							active
								? "border-border bg-muted text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{label}
						<Icon size={11} className={active ? "text-foreground" : "text-muted-foreground/40"} />
					</button>
				)
			})}
		</div>
	)
}

/** One tappable row of the mobile list that replaces the table below md. */
export function MobileListRow({ className, ...props }: React.ComponentProps<"button">) {
	return (
		<button
			type="button"
			className={cn(
				"flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
				className,
			)}
			{...props}
		/>
	)
}
