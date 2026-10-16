import { useEffect } from "react"

/**
 * Poll a refresh callback on a fixed interval while `enabled`.
 *
 * This is the sanctioned polling exception to the no-useEffect rule: effect-atom
 * exposes refresh imperatively (`useAtomRefresh`), so a timer is the only way to
 * keep a background query warm. Ticks are skipped while the tab is hidden so an
 * idle dashboard doesn't hammer the API.
 */
export function useIntervalRefresh(
	refresh: () => void,
	{
		intervalMs,
		enabled,
		catchUp = false,
	}: {
		intervalMs: number
		enabled: boolean
		/**
		 * Also refresh the moment a hidden tab returns. For a reading judged against the clock
		 * ("no read in 30 minutes"): the ticks it skipped while hidden would make it look expired.
		 */
		catchUp?: boolean
	},
) {
	useEffect(() => {
		if (!enabled) return
		const id = setInterval(() => {
			if (typeof document !== "undefined" && document.hidden) return
			refresh()
		}, intervalMs)
		if (!catchUp) return () => clearInterval(id)
		const onVisible = () => {
			if (!document.hidden) refresh()
		}
		document.addEventListener("visibilitychange", onVisible)
		return () => {
			clearInterval(id)
			document.removeEventListener("visibilitychange", onVisible)
		}
	}, [refresh, intervalMs, enabled, catchUp])
}
