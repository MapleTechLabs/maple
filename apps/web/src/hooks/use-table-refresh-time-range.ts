import * as React from "react"

import { useOptionalPageRefreshContext } from "@/components/time-range-picker/page-refresh-context"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { relativeToAbsolute } from "@/lib/time-utils"

interface UseTableRefreshTimeRangeOptions {
	startTime?: string
	endTime?: string
	timePreset?: string
	defaultRange?: string
}

interface TimeRange {
	startTime: string
	endTime: string
}

function resolveRefreshPreset({
	startTime,
	endTime,
	timePreset,
	defaultRange,
}: UseTableRefreshTimeRangeOptions): string | undefined {
	if (timePreset) return timePreset
	if (startTime || endTime) return undefined
	return defaultRange
}

export function useTableRefreshTimeRange({
	startTime,
	endTime,
	timePreset,
	defaultRange = "12h",
}: UseTableRefreshTimeRangeOptions): TimeRange {
	const baseRange = useEffectiveTimeRange(startTime, endTime, timePreset ?? defaultRange)
	const pageRefresh = useOptionalPageRefreshContext()
	const refreshVersion = pageRefresh?.refreshVersion ?? 0
	const { effectiveTimezone } = useTimezonePreference()
	const relativePreset = resolveRefreshPreset({
		startTime,
		endTime,
		timePreset,
		defaultRange,
	})
	const source = `${baseRange.startTime}\u0000${baseRange.endTime}\u0000${relativePreset ?? ""}\u0000${refreshVersion}`
	const [refreshState, setRefreshState] = React.useState(() => ({
		source,
		refreshVersion,
		range: baseRange,
	}))
	let refreshedRange = refreshState.range

	if (refreshState.source !== source) {
		// Deliberately unsnapped on an explicit reload, since the point of a reload
		// is to advance the window to the real "now". Any other change to the base
		// range — a navigation, a timezone switch moving a day-aligned preset —
		// keeps the snapped, cache-friendly range.
		const reloaded =
			pageRefresh != null && relativePreset != null && refreshState.refreshVersion !== refreshVersion
		const nextRange = reloaded
			? (relativeToAbsolute(relativePreset, effectiveTimezone) ?? baseRange)
			: baseRange
		refreshedRange = nextRange
		setRefreshState({ source, refreshVersion, range: nextRange })
	}

	return refreshedRange
}
