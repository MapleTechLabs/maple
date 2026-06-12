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
	{ intervalMs, enabled }: { intervalMs: number; enabled: boolean },
) {
	useEffect(() => {
		if (!enabled) return
		const id = setInterval(() => {
			if (typeof document !== "undefined" && document.hidden) return
			refresh()
		}, intervalMs)
		return () => clearInterval(id)
	}, [refresh, intervalMs, enabled])
}
