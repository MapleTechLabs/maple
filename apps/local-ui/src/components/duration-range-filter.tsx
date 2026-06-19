// Min/max duration filter for the filter sidebar — mirrors the web app's
// `@/components/traces/duration-range-filter`, with one local adaptation:
// changes are debounced (the web pushes per keystroke into router state, but
// locally every change re-queries chDB) and flushed on blur/Enter.

import * as React from "react"
import { ChevronDownIcon } from "@maple/ui/components/icons"
import { cn } from "@maple/ui/utils"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import type { DurationStats } from "../hooks/use-local-trace-facets"

const DEBOUNCE_MS = 300

interface DurationRangeFilterProps {
	minValue: number | undefined
	maxValue: number | undefined
	onMinChange: (value: number | undefined) => void
	onMaxChange: (value: number | undefined) => void
	durationStats?: DurationStats
	defaultOpen?: boolean
}

function useDebouncedNumberInput(value: number | undefined, onChange: (value: number | undefined) => void) {
	const [text, setText] = React.useState(value != null ? String(value) : "")
	const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const onChangeRef = React.useRef(onChange)
	onChangeRef.current = onChange

	// Re-sync from the URL when it changes externally (e.g. "Clear all").
	const [lastValue, setLastValue] = React.useState(value)
	if (value !== lastValue) {
		setLastValue(value)
		setText(value != null ? String(value) : "")
	}

	const commit = React.useCallback((raw: string) => {
		const parsed = Number(raw)
		onChangeRef.current(
			raw === "" || !Number.isFinite(parsed) || parsed < 0 ? undefined : Math.round(parsed),
		)
	}, [])

	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const raw = e.target.value
		setText(raw)
		clearTimeout(timeoutRef.current)
		timeoutRef.current = setTimeout(() => commit(raw), DEBOUNCE_MS)
	}

	const flush = () => {
		clearTimeout(timeoutRef.current)
		commit(text)
	}

	React.useEffect(() => () => clearTimeout(timeoutRef.current), [])

	return { text, handleChange, flush }
}

export function DurationRangeFilter({
	minValue,
	maxValue,
	onMinChange,
	onMaxChange,
	durationStats,
	defaultOpen = true,
}: DurationRangeFilterProps) {
	const [isOpen, setIsOpen] = React.useState(defaultOpen)
	const min = useDebouncedNumberInput(minValue, onMinChange)
	const max = useDebouncedNumberInput(maxValue, onMaxChange)

	const handleKeyDown = (flush: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") flush()
	}

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
				<span>Duration (ms)</span>
				<ChevronDownIcon className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
			</CollapsibleTrigger>
			<CollapsibleContent className="pb-3">
				<div className="space-y-3">
					<div className="flex items-center gap-2">
						<div className="flex-1">
							<Label
								htmlFor="min-duration"
								className="mb-1 block text-xs text-muted-foreground"
							>
								Min
							</Label>
							<Input
								id="min-duration"
								type="number"
								min={0}
								placeholder={
									durationStats ? String(Math.floor(durationStats.minDurationMs)) : "0"
								}
								value={min.text}
								onChange={min.handleChange}
								onBlur={min.flush}
								onKeyDown={handleKeyDown(min.flush)}
							/>
						</div>
						<span className="mt-5 text-muted-foreground">-</span>
						<div className="flex-1">
							<Label
								htmlFor="max-duration"
								className="mb-1 block text-xs text-muted-foreground"
							>
								Max
							</Label>
							<Input
								id="max-duration"
								type="number"
								min={0}
								placeholder={
									durationStats ? String(Math.ceil(durationStats.maxDurationMs)) : ""
								}
								value={max.text}
								onChange={max.handleChange}
								onBlur={max.flush}
								onKeyDown={handleKeyDown(max.flush)}
							/>
						</div>
					</div>
					{durationStats && (
						<div className="space-y-1 text-xs text-muted-foreground">
							<div className="flex justify-between">
								<span>p50:</span>
								<span className="tabular-nums">
									{formatDurationMs(durationStats.p50DurationMs)}
								</span>
							</div>
							<div className="flex justify-between">
								<span>p95:</span>
								<span className="tabular-nums">
									{formatDurationMs(durationStats.p95DurationMs)}
								</span>
							</div>
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

function formatDurationMs(ms: number): string {
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)}us`
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)}ms`
	}
	return `${(ms / 1000).toFixed(2)}s`
}
