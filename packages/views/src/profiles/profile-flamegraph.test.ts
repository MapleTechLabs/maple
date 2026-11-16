import { describe, expect, it } from "vitest"
import type { FlameChartProps } from "./flame-chart"
import {
	forgetFlameProps,
	init,
	Message,
	publishedFlameProps,
	publishFlameProps,
	releaseFlameProps,
	retainFlameProps,
	update,
} from "./profile-flamegraph"
import { profileTree } from "./profile-tree"

const stacks = [{ frames: ["main", "work"], files: ["/app/a.js", "/app/a.js"], lines: [1, 2], value: 10 }]
const propsOf = (id: string, overrides: Partial<FlameChartProps> = {}): FlameChartProps => ({
	root: profileTree({ stacks, totalValue: 10 }),
	viewKey: `${id}:all`,
	search: "",
	selectedId: null,
	resetToken: 0,
	formatValue: String,
	...overrides,
})

describe("flame chart props registry", () => {
	it("gives unchanged props the same revision and any change a new one", () => {
		const first = publishFlameProps("same", propsOf("same"))
		expect(publishFlameProps("same", propsOf("same"))).toBe(first)
		const searched = publishFlameProps("same", propsOf("same", { search: "work" }))
		expect(searched).not.toBe(first)
		expect(publishFlameProps("same", propsOf("same", { search: "work", viewKey: "same:app" }))).not.toBe(
			searched,
		)
	})

	it("keeps the props of a chart recreated under the same id, whichever chart goes first", () => {
		const props = propsOf("swap")
		publishFlameProps("swap", props)
		retainFlameProps("swap")
		// The old chart unmounts, the new one mounts, and only then does the old one forget.
		releaseFlameProps("swap")
		retainFlameProps("swap")
		forgetFlameProps("swap")
		expect(publishedFlameProps("swap")).toBe(props)
		// The new chart mounts before the old one unmounts.
		retainFlameProps("swap")
		releaseFlameProps("swap")
		forgetFlameProps("swap")
		expect(publishedFlameProps("swap")).toBe(props)
	})

	it("drops the props when the last chart under an id is gone", () => {
		publishFlameProps("gone", propsOf("gone"))
		retainFlameProps("gone")
		releaseFlameProps("gone")
		forgetFlameProps("gone")
		expect(publishedFlameProps("gone")).toBeUndefined()
	})

	it("never hands out a revision twice, for another id or for an id published again", () => {
		const seen = [
			publishFlameProps("one", propsOf("one")),
			publishFlameProps("two", propsOf("two")),
			publishFlameProps("one", propsOf("one", { resetToken: 1 })),
		]
		forgetFlameProps("one")
		seen.push(publishFlameProps("one", propsOf("one")))
		expect(new Set(seen).size).toBe(seen.length)
	})
})

describe("flame graph model", () => {
	it("follows the zoom a chart reports, so a new chart's first report clears a stale Reset", () => {
		const zoomed = update(init("chart"), Message.ChangedZoom({ isZoomed: true })).model
		expect(zoomed.isZoomed).toBe(true)
		expect(update(zoomed, Message.ChangedZoom({ isZoomed: false })).model.isZoomed).toBe(false)
	})

	it("drops a selection when the scope changes: the frame names nothing in the other tree", () => {
		const selected = update(init("chart"), Message.SelectedFrame({ nodeId: "abc" })).model
		expect(update(selected, Message.ChangedScope({ scope: "app" })).model.selectedNodeId._tag).toBe(
			"None",
		)
	})
})
