// Sticky page toolbar — search + result stats + time range. Mirrors the web
// app's `ReplaysToolbar` so the chrome reads identically in local mode.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ClockIcon, MagnifierIcon, XmarkIcon } from "@maple/ui/components/icons"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { cn } from "@maple/ui/utils"
import { TIME_RANGES } from "../lib/time"

export function Toolbar({ search, stats }: { search: ReactNode; stats: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
			{search}
			<div className="flex items-center gap-4">{stats}</div>
		</div>
	)
}

export function ToolbarSearch({
	query,
	onSearch,
	placeholder,
}: {
	query: string
	onSearch: (value: string | undefined) => void
	placeholder: string
}) {
	const [value, setValue] = useState(query)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Keep the input in sync when the param changes elsewhere (e.g. Clear all).
	useEffect(() => {
		setValue(query)
	}, [query])

	const handleChange = useCallback(
		(next: string) => {
			setValue(next)
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = setTimeout(() => {
				onSearch(next.trim() || undefined)
			}, 300)
		},
		[onSearch],
	)

	return (
		<div className="relative w-full max-w-sm">
			<MagnifierIcon
				strokeWidth={2}
				className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="text"
				value={value}
				onChange={(e) => handleChange(e.target.value)}
				placeholder={placeholder}
				className="h-9 w-full rounded-lg border border-input bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
			{value && (
				<button
					type="button"
					onClick={() => handleChange("")}
					aria-label="Clear search"
					className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
				>
					<XmarkIcon strokeWidth={2} className="size-3.5" />
				</button>
			)}
		</div>
	)
}

export function ToolbarStat({
	value,
	label,
	dot,
	danger,
}: {
	value: number
	label: string
	dot?: boolean
	danger?: boolean
}) {
	return (
		<span className="flex items-center gap-1.5 text-sm">
			{dot ? <span className="size-1.5 rounded-full bg-success" /> : null}
			<span className={cn("font-medium tabular-nums", danger && value > 0 && "text-destructive")}>
				{value.toLocaleString()}
			</span>
			<span className="text-muted-foreground">{label}</span>
		</span>
	)
}

const RANGE_LABELS: Record<string, string> = {
	"1h": "Last 1 hour",
	"6h": "Last 6 hours",
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
}

export function TimeRangeSelect({
	value,
	onChange,
}: {
	value: string
	onChange: (next: string) => void
}) {
	return (
		<div className="flex items-center gap-1.5">
			<ClockIcon strokeWidth={2} className="size-3.5 text-muted-foreground" />
			<NativeSelect size="sm" value={value} onChange={(e) => onChange(e.target.value)}>
				{TIME_RANGES.map((range) => (
					<NativeSelectOption key={range.key} value={range.key}>
						{RANGE_LABELS[range.key] ?? range.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	)
}
