import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Interaction states of the virtualized logs stream (spike S4) on `/lab/bench/logs` and `/lab/logs`:
 * scrolled, a hovered row, a resting chip's attribute card, keyboard focus, and the lab's toggles.
 * The pointer stays over the time column so no chip card opens by accident.
 */
// Signed in like the lab area: lab pages render inside the app root, which calls the API.
const desktop = {
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "logs-table",
	dataset: "default",
} as const

/** Wheel inside the stream; the virtualizer swaps rows in, the sticky area raises its shadow. */
const scrollStream = (deltaY: number) => async (page: Page) => {
	await page.getByRole("log").hover({ position: { x: 120, y: 120 } })
	await page.mouse.wheel(0, deltaY)
	await page.waitForTimeout(400)
}

const pressKeys = (keys: ReadonlyArray<string>) => async (page: Page) => {
	for (const key of keys) await page.keyboard.press(key)
}

const restOnChip = (name: RegExp) => async (page: Page) => {
	await page.getByRole("button", { name }).hover()
	await page.getByText("Attribute", { exact: true }).waitFor()
}

const clickAll = (names: ReadonlyArray<string>) => async (page: Page) => {
	for (const name of names) await page.getByRole("button", { name, exact: true }).click()
	await page.mouse.move(5, 5)
}

const bench = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario => ({
	id: `lab-bench-logs-${id}`,
	title: `Lab bench logs: ${title}`,
	path: "/lab/bench/logs",
	steps,
	...desktop,
})

const lab = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario => ({
	id: `lab-logs-${id}`,
	title: `Lab logs: ${title}`,
	path: "/lab/logs",
	steps,
	...desktop,
})

export const logsTableArea: AreaModule = {
	area: "logs-table",
	scenarios: [
		bench("scrolled", "scrolled 2,400px", scrollStream(2400)),
		bench("row-hover", "hovered row shows its actions", (page) =>
			page.getByText("Synthetic wide log row 3:", { exact: false }).hover(),
		),
		bench("chip-card", "resting on a chip opens its card", restOnChip(/^Copy attribute\.0=.*-2-0$/)),
		bench("focused", "j j j focuses the third row", pressKeys(["j", "j", "j"])),
		bench("scrolled-focused", "focus follows the keyboard past the window", async (page) => {
			await pressKeys(Array.from({ length: 30 }, () => "ArrowDown"))(page)
			await page.waitForTimeout(300)
		}),
		lab("scrolled", "scrolled 1,200px", scrollStream(1200)),
		lab("focused", "j j focuses the second row", pressKeys(["j", "j"])),
		lab("wrap-search", "wrapped, searching “pool”", clickAll(["Wrap", "Search “pool”"])),
		lab(
			"pinned-comfortable",
			"pinned user.id, comfortable",
			clickAll(["Pin user.id", "Pin http.route", "Comfortable"]),
		),
		lab("reload", "reload reveals two newer rows", async (page) => {
			await clickAll(["Reload"])(page)
			await page.waitForTimeout(800)
		}),
	],
}
