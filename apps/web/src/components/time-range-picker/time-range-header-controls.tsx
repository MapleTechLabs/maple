import { Button } from "@maple/ui/components/ui/button"

import { XmarkIcon } from "@/components/icons"

import { TimeRangePicker } from "./time-range-picker"
import { ReloadControls } from "./reload-controls"
import type { TimeRange } from "./types"
import type { TimeRangeSearch } from "./search"
import type { TimePreset } from "@/lib/time-utils"

interface TimeRangeHeaderControlsProps {
	/**
	 * The page's URL window. When given, it wins over `startTime`/`endTime` (which then act as
	 * the effective-window fallback) and the preset derives as "URL preset, else `defaultPreset`
	 * unless the URL carries an absolute range".
	 */
	search?: TimeRangeSearch
	startTime?: string
	endTime?: string
	/** Explicit preset; overrides the one derived from `search`. */
	presetValue?: string
	defaultPreset?: string
	onTimeChange: (range: TimeRange) => void
	presets?: ReadonlyArray<TimePreset>
	maxRangeSeconds?: number
}

/** The preset a URL window resolves to: its own, else the page default unless it pins an absolute range. */
export function resolveSearchPreset(search: TimeRangeSearch, defaultPreset: string): string | undefined {
	return search.timePreset ?? (search.startTime ? undefined : defaultPreset)
}

export function TimeRangeHeaderControls({
	search,
	startTime: startTimeProp,
	endTime: endTimeProp,
	presetValue: presetValueProp,
	defaultPreset = "12h",
	onTimeChange,
	presets,
	maxRangeSeconds,
}: TimeRangeHeaderControlsProps) {
	const startTime = search?.startTime ?? startTimeProp
	const endTime = search?.endTime ?? endTimeProp
	const presetValue = presetValueProp ?? (search ? resolveSearchPreset(search, defaultPreset) : undefined)
	const hasCustomRange = !presetValue && !!startTime

	return (
		<div className="flex flex-wrap items-center gap-2">
			<div className="flex items-center">
				<TimeRangePicker
					startTime={startTime}
					endTime={endTime}
					presetValue={presetValue}
					onChange={onTimeChange}
					hotkey
					presets={presets}
					maxRangeSeconds={maxRangeSeconds}
				/>
				{hasCustomRange && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="-ml-px size-7 p-0"
						onClick={() => onTimeChange({ presetValue: defaultPreset })}
						aria-label="Reset to default time range"
					>
						<XmarkIcon className="size-3" />
					</Button>
				)}
			</div>
			<ReloadControls />
		</div>
	)
}
