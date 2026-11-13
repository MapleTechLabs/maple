// @vitest-environment happy-dom
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { type ChartRange, linkedCursorStream } from "./linked-cursor"

const HOUR = 3_600_000
/** The plot's box on screen: 500px wide from x=100, over a ten-hour axis. */
const PLOT_BOX = {
	left: 100,
	right: 600,
	top: 0,
	bottom: 200,
	width: 500,
	height: 200,
	x: 100,
	y: 0,
	toJSON: () => ({}),
}

/** One chart of a linked group as the views render it: plot anchor, page overlay, cursor overlay. */
const setUp = () => {
	const group = document.createElement("div")
	group.innerHTML = `
		<div data-linked-cursor-chart="latency">
			<div data-chart-plot data-chart-time-axis="0,${10 * HOUR},0,500"></div>
			<div data-chart-overlay><button data-marker></button></div>
			<div data-linked-cursor-overlay="latency">
				<div data-linked-cursor-line></div>
				<div data-linked-zoom-band><span data-linked-zoom-label></span></div>
			</div>
		</div>`
	document.body.append(group)
	const find = (selector: string) =>
		group.querySelector<HTMLElement>(selector) ?? document.createElement("div")
	const plot = Object.assign(find("[data-chart-plot]"), { getBoundingClientRect: () => PLOT_BOX })
	return { group, plot, marker: find("[data-marker]"), label: find("[data-linked-zoom-label]") }
}
type Parts = ReturnType<typeof setUp>

const pointer = (type: string, x: number, pointerType = "mouse") =>
	new PointerEvent(type, { bubbles: true, clientX: x, clientY: 100, button: 0, pointerType })

/** The spans the zoom reports while `gesture` plays on a mounted group. */
const rangesFor = (gesture: (parts: Parts) => void) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const parts = setUp()
			const seen: Array<ChartRange> = []
			const fiber = yield* Effect.forkChild(
				Stream.runForEach(
					linkedCursorStream<ChartRange | null>(parts.group, null, {
						timeZone: "UTC",
						selected: (range) => range,
					}),
					(emitted) =>
						Effect.sync(() => {
							if (emitted !== null) seen.push(emitted)
						}),
				),
			)
			yield* Effect.sleep(10)
			yield* Effect.sync(() => gesture(parts))
			yield* Effect.sleep(10)
			yield* Fiber.interrupt(fiber)
			parts.group.remove()
			return seen
		}),
	)

describe("linked zoom gesture", () => {
	test("a drag across the plot labels the span while it moves and reports it on release", async () => {
		const labels: Array<string> = []
		const ranges = await rangesFor(({ plot, label }) => {
			plot.dispatchEvent(pointer("pointerdown", 300))
			plot.dispatchEvent(pointer("pointermove", 450))
			labels.push(label.textContent)
			plot.dispatchEvent(pointer("pointerup", 450))
			labels.push(label.textContent)
		})
		expect(ranges).toEqual([{ startMs: 4 * HOUR, endMs: 7 * HOUR }])
		expect(labels[0]).toContain("· 3h")
		expect(labels[1]).toBe("")
	})

	test("a press that barely moves is a click, not a zoom", async () => {
		const ranges = await rangesFor(({ plot }) => {
			plot.dispatchEvent(pointer("pointerdown", 300))
			plot.dispatchEvent(pointer("pointermove", 303))
			plot.dispatchEvent(pointer("pointerup", 303))
		})
		expect(ranges).toEqual([])
	})

	test("Escape drops the drag in flight", async () => {
		const ranges = await rangesFor(({ plot }) => {
			plot.dispatchEvent(pointer("pointerdown", 300))
			plot.dispatchEvent(pointer("pointermove", 450))
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
			plot.dispatchEvent(pointer("pointerup", 450))
		})
		expect(ranges).toEqual([])
	})

	test("a press on what the page lays over the plot, or a touch, starts no drag", async () => {
		const ranges = await rangesFor(({ plot, marker }) => {
			marker.dispatchEvent(pointer("pointerdown", 300))
			plot.dispatchEvent(pointer("pointermove", 450))
			plot.dispatchEvent(pointer("pointerup", 450))
			plot.dispatchEvent(pointer("pointerdown", 300, "touch"))
			plot.dispatchEvent(pointer("pointermove", 450, "touch"))
			plot.dispatchEvent(pointer("pointerup", 450, "touch"))
		})
		expect(ranges).toEqual([])
	})

	test("the click that ends a drag never reaches the chart; a plain click does", async () => {
		const clicks: Array<string> = []
		await rangesFor(({ plot }) => {
			plot.addEventListener("click", () => clicks.push("plain"))
			plot.dispatchEvent(new MouseEvent("click", { bubbles: true }))
		})
		await rangesFor(({ plot }) => {
			plot.addEventListener("click", () => clicks.push("after drag"))
			plot.dispatchEvent(pointer("pointerdown", 300))
			plot.dispatchEvent(pointer("pointermove", 450))
			plot.dispatchEvent(pointer("pointerup", 450))
			plot.dispatchEvent(new MouseEvent("click", { bubbles: true }))
		})
		expect(clicks).toEqual(["plain"])
	})
})
