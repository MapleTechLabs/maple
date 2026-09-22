// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { PathsChart } from "../paths-chart"
import { pathsSampleData } from "../../_shared/sample-data"

beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 1000,
		bottom: 360,
		width: 1000,
		height: 360,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

const rows = [
	{ hop: 1, fromNode: "/pricing", toNode: "/docs", count: 40 },
	{ hop: 1, fromNode: "/pricing", toNode: "", count: 50 },
	{ hop: 1, fromNode: "/pricing", toNode: "$other", count: 10 },
	{ hop: 2, fromNode: "/docs", toNode: "signup", count: 30 },
	{ hop: 2, fromNode: "/docs", toNode: "", count: 10 },
	{ hop: 2, fromNode: "$other", toNode: "", count: 10 },
]

describe("paths chart", () => {
	it("draws the anchor, one node per distinct name per column, and the two sentinels labelled", () => {
		const { container } = render(<PathsChart data={rows} />)
		const nodes = container.querySelectorAll("[data-slot='paths-node']")
		// col 0: /pricing · col 1: /docs, Other, Ended · col 2: signup, Ended
		expect(nodes.length).toBe(6)
		const text = container.textContent ?? ""
		expect(text).toContain("Anchor")
		expect(text).toContain("Step 1")
		expect(text).toContain("Step 2")
		expect(text).toContain("/pricing 100")
		expect(text).toContain("Ended 50")
		expect(text).toContain("Other 10")
		expect(text).not.toContain("$other")
	})

	it("draws one ribbon per hop row", () => {
		const { container } = render(<PathsChart data={rows} />)
		expect(container.querySelectorAll("path").length).toBe(rows.length)
	})

	it("labels the columns backwards for `before`", () => {
		const { container } = render(<PathsChart data={rows} direction="before" />)
		const text = container.textContent ?? ""
		expect(text).toContain("−1")
		expect(text).toContain("−2")
		expect(text).not.toContain("Step 1")
	})

	it("opens a tooltip with the node's share of the anchor and where it came from", () => {
		const { container } = render(<PathsChart data={pathsSampleData} />)
		expect(container.querySelector("[data-slot='paths-tooltip']")).toBeNull()
		const nodes = [...container.querySelectorAll("[data-slot='paths-node']")]
		// Labels truncate to the column span; the tooltip carries the full name.
		const target = nodes.find((node) => node.textContent?.startsWith("First trace"))
		expect(target).toBeDefined()
		fireEvent.pointerEnter(target!)
		const tip = container.querySelector("[data-slot='paths-tooltip']")
		expect(tip?.textContent).toContain("First trace received")
		expect(tip?.textContent).toContain("1,020")
		expect(tip?.textContent).toContain("48% of anchor")
		expect(tip?.textContent).toContain("Came fromCreated ingest key")
	})

	it("is the empty state without rows", () => {
		const { container } = render(<PathsChart data={[]} />)
		expect(container.textContent).toContain("No data")
	})
})
