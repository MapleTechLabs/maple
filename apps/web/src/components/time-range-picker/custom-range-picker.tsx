import { useState } from "react"
import { Calendar } from "@maple/ui/components/ui/calendar"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { zonedDateParts, zonedPartsToEpochMs } from "@maple/query-engine/datetime"
import type { DateRange } from "react-day-picker"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatForTinybird } from "@/lib/time-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"

interface CustomRangePickerProps {
	startTime?: string
	endTime?: string
	onApply: (range: { startTime: string; endTime: string }) => void
	onCancel: () => void
}

const TIME_INPUT = /^(\d{2}):(\d{2})$/

function parseTimeInput(input: string): { hours: number; minutes: number } | null {
	const match = TIME_INPUT.exec(input)
	if (!match) return null
	const hours = Number(match[1])
	const minutes = Number(match[2])
	return hours < 24 && minutes < 60 ? { hours, minutes } : null
}

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * The calendar and the time inputs speak the SELECTED zone's wall clock, not the
 * browser's. `react-day-picker` only knows local `Date`s, so a calendar day is
 * carried as a local-midnight `Date` built from the zone's calendar components
 * (its `getFullYear/getMonth/getDate` are then the zone's day, whatever the
 * browser's offset), and a picked day plus a typed time is turned back into an
 * instant through the zone — never through `setHours`, which would read the
 * typed hours as browser-local and shift the applied window by the difference.
 */
export function CustomRangePicker({ startTime, endTime, onApply, onCancel }: CustomRangePickerProps) {
	const { effectiveTimezone: timeZone } = useTimezonePreference()

	// Stored times are tz-less UTC warehouse strings; normalize to explicit UTC
	// before parsing or the value shifts by the local offset.
	const wallClock = (value: string) => zonedDateParts(Date.parse(normalizeTimestampInput(value)), timeZone)
	const calendarDay = (value: string) => {
		const parts = wallClock(value)
		return new Date(parts.year, parts.month - 1, parts.day)
	}
	const clock = (value: string) => {
		const parts = wallClock(value)
		return `${pad(parts.hour)}:${pad(parts.minute)}`
	}

	const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
		const from = startTime ? calendarDay(startTime) : undefined
		const to = endTime ? calendarDay(endTime) : undefined
		return from || to ? { from, to } : undefined
	})

	const [startTimeInput, setStartTimeInput] = useState(() => (startTime ? clock(startTime) : "00:00"))
	const [endTimeInput, setEndTimeInput] = useState(() => (endTime ? clock(endTime) : "23:59"))

	const handleApply = () => {
		if (!dateRange?.from || !dateRange?.to) return
		const start = parseTimeInput(startTimeInput)
		const end = parseTimeInput(endTimeInput)
		if (!start || !end) return

		const instant = (day: Date, time: { hours: number; minutes: number }) =>
			zonedPartsToEpochMs(
				{
					year: day.getFullYear(),
					month: day.getMonth() + 1,
					day: day.getDate(),
					hour: time.hours,
					minute: time.minutes,
					second: 0,
				},
				timeZone,
			)

		onApply({
			startTime: formatForTinybird(new Date(instant(dateRange.from, start))),
			endTime: formatForTinybird(new Date(instant(dateRange.to, end))),
		})
	}

	const isValidRange =
		dateRange?.from && dateRange?.to && parseTimeInput(startTimeInput) && parseTimeInput(endTimeInput)

	// "No future days" is judged on the zone's calendar too: a viewer whose
	// selected zone is already on tomorrow must be able to pick it.
	const today = (() => {
		const parts = zonedDateParts(Date.now(), timeZone)
		return new Date(parts.year, parts.month - 1, parts.day)
	})()

	return (
		<div className="flex flex-col gap-4">
			<div className="flex gap-4">
				<Calendar
					mode="range"
					selected={dateRange}
					onSelect={setDateRange}
					numberOfMonths={2}
					disabled={{ after: today }}
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
