import { useState } from "react"
import { Calendar } from "@maple/ui/components/ui/calendar"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { parse, isValid } from "date-fns"
import type { DateRange } from "react-day-picker"
import { formatForTinybird, formatZoneOffsetLabel } from "@/lib/time-utils"
import {
	normalizeTimestampInput,
	utcToZonedWallClock,
	zonedWallClockToUtc,
	type ZonedWallClock,
} from "@/lib/timezone-format"

interface CustomRangePickerProps {
	startTime?: string
	endTime?: string
	/** IANA timezone the wall-clock inputs are interpreted in. */
	timeZone: string
	onApply: (range: { startTime: string; endTime: string }) => void
	onCancel: () => void
}

const pad = (value: number) => value.toString().padStart(2, "0")

// Resolve a stored warehouse timestamp into the calendar day + "HH:mm" inputs,
// projected into `timeZone`. The Calendar tracks days via a Date's *local*
// y/m/d, so we build a local-midnight Date from the zoned wall-clock day.
function storedToWallClock(value: string, timeZone: string): { day: Date; time: string } {
	const parts = utcToZonedWallClock(new Date(normalizeTimestampInput(value)), timeZone)
	return {
		day: new Date(parts.year, parts.month - 1, parts.day),
		time: `${pad(parts.hour)}:${pad(parts.minute)}`,
	}
}

export function CustomRangePicker({
	startTime,
	endTime,
	timeZone,
	onApply,
	onCancel,
}: CustomRangePickerProps) {
	const initialStart = startTime ? storedToWallClock(startTime, timeZone) : undefined
	const initialEnd = endTime ? storedToWallClock(endTime, timeZone) : undefined

	const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
		const from = initialStart?.day
		const to = initialEnd?.day
		return from || to ? { from, to } : undefined
	})

	const [startTimeInput, setStartTimeInput] = useState(() => initialStart?.time ?? "00:00")
	const [endTimeInput, setEndTimeInput] = useState(() => initialEnd?.time ?? "23:59")

	const handleApply = () => {
		if (!dateRange?.from || !dateRange?.to) return

		const [startHour, startMin] = startTimeInput.split(":").map(Number)
		const [endHour, endMin] = endTimeInput.split(":").map(Number)

		// Combine the selected calendar day (read from the Date's local y/m/d) with
		// the entered wall-clock time, then resolve that wall-clock *in the chosen
		// timezone* to a UTC instant. This keeps the round-trip symmetric so the
		// applied range no longer jumps by the UTC offset.
		const toWall = (day: Date, hour: number, minute: number): ZonedWallClock => ({
			year: day.getFullYear(),
			month: day.getMonth() + 1,
			day: day.getDate(),
			hour: hour || 0,
			minute: minute || 0,
			second: 0,
		})

		const a = zonedWallClockToUtc(toWall(dateRange.from, startHour, startMin), timeZone)
		const b = zonedWallClockToUtc(toWall(dateRange.to, endHour, endMin), timeZone)
		// The calendar orders days, but the time inputs are independent — a
		// single-day selection with start time after end time would otherwise
		// produce a reversed (start > end) range. Order the instants ascending.
		const [startInstant, endInstant] = a.getTime() <= b.getTime() ? [a, b] : [b, a]

		onApply({
			startTime: formatForTinybird(startInstant),
			endTime: formatForTinybird(endInstant),
		})
	}

	const parseTimeInput = (input: string): { hours: number; minutes: number } | null => {
		const parsed = parse(input, "HH:mm", new Date())
		if (isValid(parsed)) {
			return { hours: parsed.getHours(), minutes: parsed.getMinutes() }
		}
		return null
	}

	const isValidRange =
		dateRange?.from && dateRange?.to && parseTimeInput(startTimeInput) && parseTimeInput(endTimeInput)

	return (
		<div className="flex flex-col gap-4">
			<div className="flex gap-4">
				<Calendar
					mode="range"
					selected={dateRange}
					onSelect={setDateRange}
					numberOfMonths={2}
					disabled={{ after: new Date() }}
				/>
			</div>

			<div className="flex gap-4 items-end">
				<div className="flex-1 space-y-1">
					<label className="text-xs text-muted-foreground">Start time</label>
					<Input
						type="time"
						value={startTimeInput}
						onChange={(e) => setStartTimeInput(e.target.value)}
						className="font-mono"
					/>
				</div>
				<div className="flex-1 space-y-1">
					<label className="text-xs text-muted-foreground">End time</label>
					<Input
						type="time"
						value={endTimeInput}
						onChange={(e) => setEndTimeInput(e.target.value)}
						className="font-mono"
					/>
				</div>
			</div>

			<p className="text-[11px] text-muted-foreground">
				Times are in {timeZone.replace(/_/g, " ")} ({formatZoneOffsetLabel(timeZone)})
			</p>

			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button size="sm" onClick={handleApply} disabled={!isValidRange}>
					Apply
				</Button>
			</div>
		</div>
	)
}
