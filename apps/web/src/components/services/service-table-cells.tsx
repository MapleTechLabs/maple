// Shared cell + header primitives for the service detail tables (Operations,
// API, Dependencies). Extracted when the API tab became the third table with
// the same distribution-bar treatment — a copy per tab is how the three drift.

import type { ReactNode } from "react"
import { cn } from "@maple/ui/lib/utils"
import { TableCell, TableHead } from "@maple/ui/components/ui/table"
import { Eyebrow, eyebrowVariants } from "@maple/ui/components/ui/eyebrow"
import { SortableHeader } from "@/components/common/sortable-header"
import type { SortDir } from "@/hooks/use-table-sort"
import { ChevronDownIcon, ChevronUpIcon, ChevronExpandYIcon } from "@/components/icons"

/** Shared chrome for the desktop table and the mobile list of the service detail tabs. */
export const TABLE_CARD_CLASS = "overflow-hidden rounded-lg border bg-card"

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

/** Sortable column header (right-aligned by default): the shared `SortableHeader` inside a `HeadLabel` with `aria-sort`. */
export function SortColumnHead<K extends string>({
	label,
	sortKey,
	activeKey,
	dir,
	onSort,
	align = "right",
	className,
}: {
	label: string
	sortKey: K
	activeKey: K | null
	dir: SortDir
	onSort: (key: K) => void
	align?: "left" | "right"
	className?: string
}) {
	const active = activeKey === sortKey
	return (
		<HeadLabel
			aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
			className={cn(align === "right" && "text-right", className)}
		>
			<SortableHeader
				label={label}
				sortKey={sortKey}
				activeKey={activeKey}
				dir={dir}
				onSort={onSort}
				className={cn(align === "right" && "w-full justify-end")}
			/>
		</HeadLabel>
	)
}

/** Non-sortable column header, styled to match `SortColumnHead`. */
export function HeadLabel({ className, ...props }: React.ComponentProps<"th">) {
	return <TableHead className={cn(eyebrowVariants(), "h-8", className)} {...props} />
}

interface MobileSortBarProps<K extends string> {
	options: ReadonlyArray<readonly [K, string]>
	sortKey: K | null
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

/** Metric line under a mobile list row: `calls 1.2  err 0.4%  p95 120ms`. Children are `MobileStat`s. */
export function MobileStatLine({ children }: { children: ReactNode }) {
	return <div className="flex items-center gap-3 font-mono text-xs tabular-nums">{children}</div>
}

export function MobileStat({ label, children }: { label: string; children: ReactNode }) {
	return (
		<span>
			<span className="text-muted-foreground/60">{label} </span>
			{children}
		</span>
	)
}
