// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// Sticky page toolbar family — search + result stats + time range + refresh.
// Data-agnostic: callers own the time-range presets and the refresh action.

import { useCallback, useRef, useState, type ReactNode } from "react"

import { ArrowRotateClockwiseIcon, ClockIcon } from "./icons"
import { Button } from "./ui/button"
import { NativeSelect, NativeSelectOption } from "./ui/native-select"
import { SearchInput } from "./ui/search-input"
import { StatusDot } from "./ui/status-dot"
import { useDebouncedCallback } from "../hooks/use-debounced-callback"
import { cn } from "../lib/utils"
import { TONE_TEXT, type Tone } from "../lib/tone"
import { formatNumber } from "../lib/format"

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn("flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3", className)}
		>
			{children}
		</div>
	)
}

/** Right-hand cluster of `ToolbarStat`s. */
export function ToolbarStats({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("flex items-center gap-4", className)}>{children}</div>
}

/** Manual reload button; the caller supplies the refetch action (it resolves when done). */
export function RefreshButton({
	onRefresh,
	className,
}: {
	onRefresh: () => Promise<unknown>
	className?: string
}) {
	const [spinning, setSpinning] = useState(false)

	const onClick = useCallback(() => {
		setSpinning(true)
		onRefresh().finally(() => setSpinning(false))
	}, [onRefresh])

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Reload"
			title="Reload"
			onClick={onClick}
			disabled={spinning}
			className={className}
		>
			<ArrowRotateClockwiseIcon className={spinning ? "animate-spin" : undefined} />
		</Button>
	)
}

export function ToolbarSearch({
	query,
	onSearch,
	placeholder,
	debounceMs = 300,
	size = "default",
	className,
}: {
	query: string
	onSearch: (value: string | undefined) => void
	placeholder: string
	debounceMs?: number
	size?: "sm" | "default"
	className?: string
}) {
	const [value, setValue] = useState(query)
	// The trimmed value we last pushed to `onSearch`, in the form it comes back as
	// `query`. Lets us tell an external `query` change (Clear all, back/forward) from
	// our own debounced search echoing back, so a resync never clobbers keystrokes
	// typed during the round-trip.
	const lastSentRef = useRef(query)

	// Keep the input in sync when the param changes elsewhere (e.g. Clear all) —
	// during render, and never for our own echo.
	const [lastQuery, setLastQuery] = useState(query)
	if (query !== lastQuery) {
		setLastQuery(query)
		if (query !== lastSentRef.current) {
			setValue(query)
		}
	}

	const debouncedSearch = useDebouncedCallback((next: string) => {
		const trimmed = next.trim() || undefined
		lastSentRef.current = trimmed ?? ""
		onSearch(trimmed)
	}, debounceMs)

	const handleChange = useCallback(
		(next: string) => {
			setValue(next)
			debouncedSearch(next)
		},
		[debouncedSearch],
	)

	return (
		<SearchInput
			size={size}
			value={value}
			onValueChange={handleChange}
			placeholder={placeholder}
			className={cn("max-w-sm", className)}
		/>
	)
}

export function ToolbarStat({
	value,
	label,
	dot,
	danger,
	tone,
}: {
	/** Numbers are formatted; strings (rates, durations) render as given. */
	value: number | string
	label: string
	dot?: boolean
	danger?: boolean
	tone?: Tone
}) {
	return (
		<span className="flex items-center gap-1.5 whitespace-nowrap text-sm">
			{dot ? <StatusDot tone="ok" /> : null}
			<span
				className={cn(
					"font-medium tabular-nums",
					tone && TONE_TEXT[tone],
					danger && typeof value === "number" && value > 0 && TONE_TEXT.crit,
				)}
			>
				{typeof value === "number" ? formatNumber(value) : value}
			</span>
			<span className="text-muted-foreground">{label}</span>
		</span>
	)
}

export interface TimeRangeOption {
	key: string
	label: string
}

export function TimeRangeSelect({
	ranges,
	value,
	onChange,
}: {
	ranges: ReadonlyArray<TimeRangeOption>
	value: string
	onChange: (next: string) => void
}) {
	return (
		<div className="flex items-center gap-1.5">
			<ClockIcon strokeWidth={2} className="size-3.5 text-muted-foreground" />
			<NativeSelect
				size="sm"
				aria-label="Time range"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				{ranges.map((range) => (
					<NativeSelectOption key={range.key} value={range.key}>
						{range.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	)
}
