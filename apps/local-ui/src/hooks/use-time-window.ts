import { useCallback, useMemo, useState } from "react"
import { boundsForRange, snapToMinute } from "../lib/time"

/**
 * One page-owned time window shared by a view's list, facets and charts.
 * The anchor is snapped to the minute and only moves on `advance()` (the
 * refresh button), so paging and filter clicks never shift the window.
 */
export function useTimeWindow(range: string | undefined) {
	const [anchorMs, setAnchorMs] = useState(() => snapToMinute(Date.now()))
	const bounds = useMemo(() => boundsForRange(range, anchorMs), [anchorMs, range])
	/** Move the anchor to now. Returns false when it was already current (same minute). */
	const advance = useCallback((): boolean => {
		const next = snapToMinute(Date.now())
		if (next === anchorMs) return false
		setAnchorMs(next)
		return true
	}, [anchorMs])

	return { bounds, anchorMs, advance }
}
