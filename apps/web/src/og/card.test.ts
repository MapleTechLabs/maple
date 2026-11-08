import { describe, expect, it } from "vitest"
import type { ShareOgCardTile } from "@maple/domain/http"
import { ogCardNode } from "./card"
import { Array as Arr, Option, String as Str } from "effect"

/** Walks the node tree, since takumi nodes are plain nested objects. */
const flatten = (node: unknown): Array<Record<string, unknown>> => {
	if (typeof node !== "object" || node === null) return []
	const record = node as Record<string, unknown>
	const children = Arr.isArray(record.children) ? record.children : []
	return [record, ...Arr.flatMap(children, flatten)]
}

const texts = (node: unknown): Array<string> =>
	Arr.map(
		Arr.filter(flatten(node), (child) => child.type === "text"),
		(child) => String(child.text),
	)

const fontSizeOf = (node: unknown, label: string): number | undefined => {
	const match = Option.getOrUndefined(
		Arr.findFirst(flatten(node), (child) => child.type === "text" && child.text === label),
	)
	return (match?.style as Record<string, number> | undefined)?.fontSize
}

const tile = (title: string, section?: string): ShareOgCardTile => {
	const base = { x: 0, y: 0, w: 6, h: 4, title, visualization: "chart" }
	return section === undefined ? base : { ...base, section }
}

const tiles = (count: number, section?: string): Array<ShareOgCardTile> =>
	Array.from({ length: count }, (_, index) => tile(`Widget ${index + 1}`, section))

describe("ogCardNode", () => {
	it("leads with the board's name, its author's description and its widget names", () => {
		const node = ogCardNode({
			title: "Checkout health",
			description: "Latency, traffic and errors for the checkout path.",
			widgetCount: 2,
			tiles: [tile("Requests"), tile("Error rate")],
		})

		expect(texts(node)).toEqual(
			expect.arrayContaining([
				"MAPLE",
				"Checkout health",
				"Latency, traffic and errors for the checkout path.",
				"Requests",
				"Error rate",
			]),
		)
	})

	it("names the org that published the link, with its own logo", () => {
		const node = ogCardNode({
			title: "Board",
			org: { name: "Acme Rockets", imageUrl: "https://img.example/acme.png" },
			tiles: [],
		})
		const images = Arr.filter(flatten(node), (child) => child.type === "image")

		expect(texts(node)).toContain("Acme Rockets")
		expect(Arr.map(images, (child) => String(child.src))).toContain("https://img.example/acme.png")
	})

	it("falls back to the org's initial when it has no logo of its own", () => {
		const node = ogCardNode({ title: "Board", org: { name: "acme rockets" }, tiles: [] })

		expect(texts(node)).toContain("A")
		// Only the Maple mark is left as artwork.
		expect(Arr.filter(flatten(node), (child) => child.type === "image")).toHaveLength(1)
	})

	it("carries no byline at all when there is no directory to ask", () => {
		const node = ogCardNode({ title: "Board", tiles: [] })

		expect(texts(node)).toEqual(["MAPLE", "Board", "No widgets yet"])
	})

	it("groups widgets under the section headings their board gave them", () => {
		const node = ogCardNode({
			title: "Board",
			widgetCount: 3,
			tiles: [
				tile("Availability", "Service level"),
				tile("Deploys", "Context"),
				tile("Top errors", "Context"),
			],
		})

		// Upper-cased here rather than in the data: the heading is a label in this
		// design, and the board stores it as its author typed it.
		expect(texts(node)).toEqual(
			expect.arrayContaining(["SERVICE LEVEL", "Availability", "CONTEXT", "Deploys", "Top errors"]),
		)
	})

	it("counts the widgets it could not name rather than dropping them silently", () => {
		const node = ogCardNode({ title: "Board", widgetCount: 20, tiles: tiles(10) })

		expect(Arr.some(texts(node), (value) => Str.startsWith("+")(value))).toBe(true)
		expect(texts(node)).toContain("+13 more")
	})

	it("never runs the list past the bottom of the card", () => {
		// Eight rows is the budget the layout is built around; a board with more
		// widgets than that has to lose rows, not overflow.
		const node = ogCardNode({ title: "Board", widgetCount: 30, tiles: tiles(20) })
		const named = Arr.filter(texts(node), (value) => Str.startsWith("Widget ")(value))

		expect(named.length).toBeLessThanOrEqual(8)
	})

	it("shrinks the headline as the name grows, so it always clears the list", () => {
		const short = ogCardNode({ title: "Checkout", tiles: [] })
		const long = ogCardNode({
			title: "Production reliability review for checkout and payments",
			tiles: [],
		})

		expect(fontSizeOf(short, "Checkout")).toBeGreaterThan(
			fontSizeOf(long, "Production reliability review for checkout and payments") ?? 0,
		)
	})

	it("keeps a short list in one column", () => {
		const node = ogCardNode({ title: "Board", widgetCount: 3, tiles: tiles(3) })
		const columns = Arr.filter(
			flatten(node),
			(child) => (child.style as Record<string, unknown> | undefined)?.width === "50%",
		)

		expect(columns).toHaveLength(1)
	})

	it("balances a long list across two columns instead of stranding one name", () => {
		const node = ogCardNode({ title: "Board", widgetCount: 6, tiles: tiles(6) })
		const columns = Arr.filter(
			flatten(node),
			(child) => (child.style as Record<string, unknown> | undefined)?.width === "50%",
		)

		expect(columns).toHaveLength(2)
		expect(Arr.map(columns, (column) => (column.children as Array<unknown>).length)).toEqual([3, 3])
	})
})
