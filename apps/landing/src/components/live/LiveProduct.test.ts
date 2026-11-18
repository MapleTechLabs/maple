// @vitest-environment happy-dom
import { Option } from "effect"
import { describe, expect, it, vi } from "vitest"
import start from "../../foldkit-island/client"
import renderer from "../../foldkit-island/server"
import { biggestDrop, FUNNEL, PATHS_ANCHOR, pathsTotal } from "./live-product-data"
import { LiveProductFunnel } from "./LiveProductFunnel"
import { LiveProductPaths } from "./LiveProductPaths"

const pressed = (element: Element) =>
	element.querySelector("[role=group] button[aria-pressed=true]")?.textContent

describe("LiveProductFunnel island", () => {
	it("serves the drop-off chart, then the switch swaps it for the bars and back", async () => {
		const element = document.body.appendChild(document.createElement("astro-island"))
		const { html } = await renderer.renderToStaticMarkup(LiveProductFunnel, {})
		element.innerHTML = html
		expect(element.querySelector("[data-slot=funnel-dropoff]")).not.toBeNull()
		expect(element.textContent).toContain("before plan_started")

		await start(element)(LiveProductFunnel, {})
		const press = (label: string) =>
			element.querySelector<HTMLButtonElement>(`[role=group] button[aria-label='${label}']`)?.click()
		press("Bars")
		await vi.waitFor(() => expect(pressed(element)).toBe("Bars"))
		expect(element.querySelector("[data-slot=funnel-dropoff]")).toBeNull()
		press("Drop-off")
		await vi.waitFor(() => expect(element.querySelector("[data-slot=funnel-dropoff]")).not.toBeNull())
	})
})

describe("LiveProductPaths island", () => {
	it("names the anchor and counts everyone who left it", async () => {
		const { html } = await renderer.renderToStaticMarkup(LiveProductPaths, {})
		expect(html).toContain(`What people did after ${PATHS_ANCHOR}`)
		expect(html).toContain("742 people")
	})
})

describe("live product data", () => {
	it("finds the step that loses the largest share of the step before it", () => {
		// 1206 → 742 loses 38%, 742 → 388 loses 48%, 388 → 61 loses 84%.
		const drop = Option.getOrThrow(biggestDrop(FUNNEL))
		expect(drop.name).toBe("plan_started")
		expect(drop.share).toBeCloseTo(1 - 61 / 388)
	})

	it("explains every person who dropped at each step, largest group first", () => {
		// The drop-off tooltip shows each leaver as a share of the drop, so they must add up to it.
		FUNNEL.forEach((step, index) => {
			const previous = FUNNEL[index - 1]
			if (previous === undefined) return
			const leavers = (step.leavers ?? []).reduce((sum, leaver) => sum + leaver.count, 0)
			expect(leavers, step.name).toBe(previous.value - step.value)
			const counts = (step.leavers ?? []).map((leaver) => leaver.count)
			expect(counts, `${step.name} leavers, largest first`).toEqual([...counts].sort((x, y) => y - x))
		})
	})

	it("has no biggest drop for a single step", () => {
		expect(Option.isNone(biggestDrop(FUNNEL.slice(0, 1)))).toBe(true)
	})

	it("counts the people at the anchor from the first hop", () => {
		expect(pathsTotal).toBe(410 + 160 + 92 + 50 + 30)
	})
})
