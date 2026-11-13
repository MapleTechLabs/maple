// @vitest-environment happy-dom
import { Virtualizer } from "@tanstack/virtual-core"
import { describe, expect, test } from "vitest"
import { bindFindable, type FindableMatch } from "./findable"
import { DOM_OPTIONS, type Instance } from "./virtualizer"

const ROW_HEIGHT = 30

/** A scroller with both stand-in layers, as `findableLayers` renders them, over a measured virtualizer. */
const setUp = (count: number, scrollMargin = 0) => {
	const scroller = document.createElement("div")
	scroller.innerHTML = `
		<div role="log">
			<div data-findable-side="before"><div hidden="until-found" data-group>
				<div hidden="until-found" data-findable-index="3">row 3</div>
			</div></div>
			<div data-findable-side="after"><div hidden="until-found" data-group>
				<div hidden="until-found" data-findable-index="40">row 40</div>
				<div hidden="until-found" data-findable-index="99">row 99</div>
			</div></div>
		</div>`
	document.body.append(scroller)
	const virtualizer: Instance = new Virtualizer<HTMLElement, HTMLElement>({
		count,
		getScrollElement: () => scroller,
		estimateSize: () => ROW_HEIGHT,
		scrollMargin,
		...DOM_OPTIONS,
	})
	virtualizer.getVirtualItems()
	const matches: Array<FindableMatch> = []
	const unbind = bindFindable(scroller, virtualizer, (match) => matches.push(match))
	const standIn = (index: number) =>
		scroller.querySelector<HTMLElement>(`[data-findable-index="${index}"]`) ??
		document.createElement("div")
	// The browser fires `beforematch` on the stand-in, then on its group; it bubbles.
	const match = (index: number) => {
		const target = standIn(index)
		target.dispatchEvent(new Event("beforematch", { bubbles: true }))
		target.parentElement?.dispatchEvent(new Event("beforematch", { bubbles: true }))
	}
	return { scroller, matches, unbind, standIn, match }
}

describe("bindFindable", () => {
	test("a match moves the stand-in to its row's offset and reports the row and its side, once", () => {
		const list = setUp(50)
		list.match(40)
		expect(list.standIn(40).style.top).toBe(`${40 * ROW_HEIGHT}px`)
		expect(list.standIn(40).style.height).toBe(`${ROW_HEIGHT}px`)
		list.match(3)
		expect(list.matches).toEqual([
			{ index: 40, side: "after" },
			{ index: 3, side: "before" },
		])
	})

	test("the offset is in the list's coordinates: the scroll margin is taken off", () => {
		const list = setUp(50, 120)
		list.match(40)
		expect(list.standIn(40).style.top).toBe(`${40 * ROW_HEIGHT}px`)
	})

	test("a row the virtualizer has not counted yet is not reported or moved", () => {
		const list = setUp(50)
		list.match(99)
		expect(list.matches).toEqual([])
		expect(list.standIn(99).style.top).toBe("")
	})

	test("unbinding stops reporting matches", () => {
		const list = setUp(50)
		list.unbind()
		list.match(40)
		expect(list.matches).toEqual([])
	})
})
