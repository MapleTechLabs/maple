// The comparison the parity bench acts out. Pure: every number the figure shows comes from here.

// The Foldkit button that drifts: 14 x 5 world px, moved 4 px when padding goes 16 -> 12.
export const BUTTON = { w: 14, d: 5 }
export const DRIFT = 4

// Pixels that differ when a solid w x d block slides by s along its width.
export const changedPixels = (shift) => (shift === 0 ? 0 : 2 * Math.min(shift, BUTTON.w) * BUTTON.d)

export const PAGES = ["Overview", "Traces", "Logs", "Dashboards"]

// A port that fails gets fixed and re-run before the bench moves on.
export const RUNS = [
	{ page: 0, note: "", drift: 0, extraCall: false },
	{ page: 1, note: "padding 16 → 12", drift: DRIFT, extraCall: false },
	{ page: 1, note: "port fixed, re-run", drift: 0, extraCall: false },
	{ page: 2, note: "", drift: 0, extraCall: false },
	{ page: 3, note: "fetches twice", drift: 0, extraCall: true },
	{ page: 3, note: "port fixed, re-run", drift: 0, extraCall: false },
]

// Diff counts per gauge, left to right: pixels, structure root causes, call-log deltas, ARIA lines.
export const diffsOf = (run) => ({
	pixels: changedPixels(run.drift),
	structure: run.drift === 0 ? 0 : 1,
	calls: run.extraCall ? 1 : 0,
	a11y: 0,
})

export const GAUGE_FULL = { pixels: 100, structure: 4, calls: 4, a11y: 4 }

export const isIdentical = (diffs) => diffs.pixels + diffs.structure + diffs.calls + diffs.a11y === 0

// What each page's light shows once a run has been read: the latest verdict per page.
export function verdictsAfter(runIndex) {
	const verdicts = PAGES.map(() => "idle")
	for (let i = 0; i <= runIndex; i++) verdicts[RUNS[i].page] = isIdentical(diffsOf(RUNS[i])) ? "ok" : "fail"
	return verdicts
}

// One run, in seconds: swap screens, travel to React, shutter, travel to Foldkit, shutter, read, hold.
export const PHASES = [
	{ name: "swap", length: 1.75 },
	{ name: "toLegacy", length: 1.4 },
	{ name: "captureLegacy", length: 0.9 },
	{ name: "toFoldkit", length: 1.75 },
	{ name: "captureFoldkit", length: 0.9 },
	{ name: "read", length: 1.6 },
	{ name: "hold", length: 2.4 },
]
export const RUN_LENGTH = PHASES.reduce((sum, phase) => sum + phase.length, 0)

export function phaseAt(t) {
	let at = ((t % RUN_LENGTH) + RUN_LENGTH) % RUN_LENGTH
	for (const phase of PHASES) {
		if (at < phase.length) return { name: phase.name, progress: at / phase.length }
		at -= phase.length
	}
	return { name: "hold", progress: 1 }
}
