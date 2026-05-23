import * as React from "react"
import { useReplayPlayer } from "@/components/replays/replay-player-context"
import { isDialogOpen, isEditableTarget } from "@/lib/keyboard"

/** Arrow-key seek step, in display ms. */
export const SEEK_STEP_MS = 5000

/**
 * Page-wide keyboard transport for the replay player:
 * - Space → play/pause (from anywhere on the page)
 * - Left / Right → seek ∓ {@link SEEK_STEP_MS}
 *
 * Mount once inside a {@link useReplayPlayer} provider. Guards against typing
 * in text fields and open dialogs (see `@/lib/keyboard`).
 */
export function useReplayKeyboardShortcuts(): void {
	const { togglePlay, seekDisplay, displayCurrentMs, displayTotalMs } = useReplayPlayer()

	// The player advances `displayCurrentMs` every animation frame while playing.
	// Read position from a ref so the keydown listener stays subscribed across
	// those ticks instead of re-attaching ~60×/s.
	const stateRef = React.useRef({ displayCurrentMs, displayTotalMs })
	stateRef.current = { displayCurrentMs, displayTotalMs }

	React.useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return
			if (isEditableTarget(e.target)) return
			if (isDialogOpen()) return

			switch (e.code) {
				case "Space": {
					e.preventDefault() // otherwise the page scrolls
					togglePlay()
					break
				}
				case "ArrowLeft": {
					e.preventDefault()
					const { displayCurrentMs: cur } = stateRef.current
					seekDisplay(Math.max(0, cur - SEEK_STEP_MS))
					break
				}
				case "ArrowRight": {
					e.preventDefault()
					const { displayCurrentMs: cur, displayTotalMs: total } = stateRef.current
					seekDisplay(Math.min(total, cur + SEEK_STEP_MS))
					break
				}
			}
		}

		window.addEventListener("keydown", handler)
		return () => window.removeEventListener("keydown", handler)
	}, [togglePlay, seekDisplay])
}
