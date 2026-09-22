// @vitest-environment jsdom
import { test } from "vitest"
import { approximateSize } from "../platform/approximate-size"
import type { SessionEvent } from "../events/events-sink"
import { installConsoleCapture } from "../replay/capture/console"
import { installInteractionCapture } from "./interactions"

/**
 * The capture modules sit on host-app hot paths: every `console.log`, every
 * click. This measures what installing them costs the app that installed us,
 * against the same work with capture absent.
 *
 * Read the ratios, not the absolutes — jsdom is not a browser. Run with
 * `bun run bench` in this package.
 *
 * ## What this settled (measured 2026-08-14, M-series, jsdom)
 *
 * A review flagged that a captured console call is serialized three times:
 * `formatArgs` stringifies each argument, `approximateSize` stringifies the
 * whole event again for flush accounting, and `toRow` stringifies a third time
 * at flush. The numbers say that is real but not worth fixing:
 *
 * - console capture adds **~180 ns per call** (51.5M/s → 5.0M/s against a
 *   no-op sink). Against a *real* console write — far more expensive than the
 *   no-op measured here — the same overhead is ~7%.
 * - `approximateSize` is ~120 ns of that 180 ns, so the redundant pass really
 *   is most of the cost. It is still 120 ns.
 * - an app logging 100 lines a second therefore pays ~18 µs/s: about 0.002% of
 *   one core.
 * - click capture adds ~0.5 µs per click (1.19x), which at human click rates
 *   is unmeasurable.
 *
 * So the third serialization stays. Removing it would trade a genuinely tricky
 * size-estimation path (the fallback exists because events can contain cycles)
 * for a saving no user can perceive. Revisit if capture ever moves onto a path
 * that runs thousands of times a second — long stacks are the one shape that
 * gets expensive, at ~800 ns.
 */

const noopEmit = (_event: SessionEvent): void => {}
const args = [
	"user action failed",
	{ userId: "u_1", org: "acme", attempt: 3, nested: { a: 1, b: [1, 2, 3] } },
	new Error("boom"),
]

for (const capture of [false, true]) {
	test(`console.log, capture ${capture ? "installed" : "absent"}`, async ({ bench }) => {
		const realLog = console.log
		console.log = () => {}
		const uninstall = capture ? installConsoleCapture(noopEmit) : undefined
		try {
			await bench("console.log", () => console.log(...args)).run()
		} finally {
			uninstall?.()
			console.log = realLog
		}
	})
	test(`click, capture ${capture ? "installed" : "absent"}`, async ({ bench }) => {
		const button = document.createElement("button")
		button.id = "save"
		button.className = "btn btn-primary"
		button.textContent = "Save changes"
		document.body.appendChild(button)
		const uninstall = capture ? installInteractionCapture(noopEmit, false) : undefined
		try {
			await bench("click", () => button.click()).run()
		} finally {
			uninstall?.()
			button.remove()
		}
	})
}

const payloads = {
	"console event": {
		type: "console",
		level: "log",
		message: 'user action failed {"userId":"u_1","org":"acme"} Error: boom',
	},
	"small click event": { type: "click", targetSelector: "button#save" },
	"network event": {
		type: "network",
		net: { method: "POST", url: "https://api.example.com/v1/orders", status: 201, durationMs: 143 },
	},
	"error with a long stack": {
		type: "error",
		level: "error",
		message: "Unhandled rejection",
		errorStack: "Error: boom\n".repeat(120),
	},
} satisfies Record<string, SessionEvent>
for (const [name, payload] of Object.entries(payloads)) {
	test(`approximateSize: ${name}`, async ({ bench }) => {
		await bench(name, () => approximateSize(payload)).run()
	})
}
