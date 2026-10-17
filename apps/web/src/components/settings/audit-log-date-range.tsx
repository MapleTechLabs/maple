import { useState } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { cn } from "@maple/ui/lib/utils"

import { ClockIcon } from "@/components/icons"
import { CustomRangePicker } from "@/components/time-range-picker/custom-range-picker"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone, normalizeTimestampInput } from "@/lib/timezone-format"

import { AUDIT_RANGE_PRESETS, type AuditDateRange } from "./audit-log-filters"

const ALL_TIME: AuditDateRange = { kind: "all" }

function useRangeLabel(range: AuditDateRange): string {
	const { effectiveTimezone } = useTimezonePreference()
	if (range.kind === "all") return "All time"
	if (range.kind === "preset") {
		return AUDIT_RANGE_PRESETS.find((preset) => preset.value === range.preset)?.label ?? "All time"
	}
	const format = (value: string) => formatTimestampInTimezone(value, { timeZone: effectiveTimezone })
	if (range.since !== undefined && range.until !== undefined) {
		return `${format(range.since)} to ${format(range.until)}`
	}
	if (range.since !== undefined) return `Since ${format(range.since)}`
	if (range.until !== undefined) return `Until ${format(range.until)}`
	return "All time"
}

/** The audit log's window: everything, a rolling preset, or a fixed range. */
export function AuditLogDateRange({
	value,
	onChange,
}: {
	value: AuditDateRange
	onChange: (range: AuditDateRange) => void
}) {
	const [open, setOpen] = useState(false)
	const [custom, setCustom] = useState(false)
	const label = useRangeLabel(value)

	function select(range: AuditDateRange) {
		onChange(range)
		setOpen(false)
		setCustom(false)
	}

	const options: ReadonlyArray<{ key: string; label: string; range: AuditDateRange }> = [
		{ key: "all", label: "All time", range: ALL_TIME },
		...AUDIT_RANGE_PRESETS.map((preset) => ({
			key: preset.value,
			label: preset.label,
			range: { kind: "preset", preset: preset.value } satisfies AuditDateRange,
		})),
	]
	const activeKey = value.kind === "all" ? "all" : value.kind === "preset" ? value.preset : null

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next)
				if (!next) setCustom(false)
			}}
		>
			<PopoverTrigger
				render={
					<Button
						variant="outline"
						size="sm"
						className="gap-1.5"
						aria-label={`Date range: ${label}`}
					>
						<ClockIcon />
						<span>{label}</span>
					</Button>
				}
			/>
			<PopoverContent
				align="start"
				className={custom ? "w-auto max-w-[calc(100vw-1.5rem)] p-4" : "w-48 p-0"}
			>
				{custom ? (
					<CustomRangePicker
						startTime={value.kind === "custom" ? value.since : undefined}
						endTime={value.kind === "custom" ? value.until : undefined}
						onApply={(range) =>
							select({
								kind: "custom",
								since: normalizeTimestampInput(range.startTime),
								until: normalizeTimestampInput(range.endTime),
							})
						}
						onCancel={() => setCustom(false)}
					/>
				) : (
					<div className="flex flex-col py-1.5">
						{options.map((option) => (
							<button
								key={option.key}
								type="button"
								onClick={() => select(option.range)}
								className={cn(
									"flex h-7 items-center px-3 text-left text-xs transition-colors hover:bg-muted/50",
									option.key === activeKey
										? "font-medium text-foreground"
										: "text-foreground/80",
								)}
							>
								{option.label}
							</button>
						))}
						<div className="mx-3 my-1 h-px bg-border/60" />
						<button
							type="button"
							onClick={() => setCustom(true)}
							className={cn(
								"flex h-7 items-center px-3 text-left text-xs transition-colors hover:bg-muted/50 hover:text-foreground",
								value.kind === "custom"
									? "font-medium text-foreground"
									: "text-muted-foreground",
							)}
						>
							Custom range…
						</button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	)
}
