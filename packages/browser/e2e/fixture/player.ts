// Replays captured chunks the way the dashboard player does, so a test can
// assert on what a viewer of the recording would actually see.
import { Replayer } from "rrweb"

declare global {
	interface Window {
		/** Rebuild the recorded page at its last event and return the replayed document. */
		replayToEnd: (events: ReadonlyArray<{ readonly timestamp: number }>) => Promise<Document>
	}
}

window.replayToEnd = async (events) => {
	const root = document.getElementById("root")
	if (root === null) throw new Error("player root missing")
	root.replaceChildren()
	const replayer = new Replayer(events as never, {
		root,
		skipInactive: false,
		showWarning: false,
		showDebug: false,
		mouseTail: false,
	})
	const first = events[0]?.timestamp ?? 0
	const last = events.at(-1)?.timestamp ?? first
	replayer.pause(last - first + 1)
	await new Promise((resolve) => requestAnimationFrame(resolve))
	const replayed = replayer.iframe.contentDocument
	if (replayed === null) throw new Error("replayer iframe has no document")
	return replayed
}
