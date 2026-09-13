import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderFunnelChart } from "../query-builder-funnel-chart"
import { funnelDropoffSampleData } from "../../_shared/sample-data"

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
		right: 800,
		bottom: 320,
		width: 800,
		height: 320,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

const stages = [
	{ name: "Visited", value: 100 },
	{ name: "Signed up", value: 40 },
	{ name: "Purchased", value: 20 },
]

describe("query-builder funnel: the drop-off variant", () => {
	it("draws one column per step with the loss since the previous step", () => {
		const { container } = render(
			<QueryBuilderFunnelChart data={stages} variant="dropoff" showStepPercent />,
		)
		expect(container.querySelectorAll("[data-slot='funnel-dropoff-step']").length).toBe(3)
		// Step 1 has nothing to lose; steps 2 and 3 carry a hatched cap.
		expect(container.querySelectorAll("[data-slot='funnel-dropoff-lost']").length).toBe(2)
		const pills = Array.from(
			container.querySelectorAll("[data-slot='funnel-dropoff-pill']"),
			(el) => el.textContent,
		)
		// Step-to-step conversion and the loss, at the foot of each bar past the first.
		expect(pills).toEqual(["40%60%", "50%50%"])
		const text = container.textContent ?? ""
		// Share of first heads every column, its count beneath.
		expect(text).toContain("40%")
		expect(text).toContain("20%")
		expect(text).toContain("100")
		// The overall rate: last step over first.
		const summary = container.querySelector("[data-slot='funnel-dropoff-summary']")
		expect(summary?.textContent).toBe("Conversion rate20%")
	})

	it("hides every percentage when asked to", () => {
		const { container } = render(
			<QueryBuilderFunnelChart data={stages} variant="dropoff" showStepPercent={false} />,
		)
		expect(container.textContent).not.toContain("%")
	})

	it("shows the median time between steps and, on hover, where the leavers went", () => {
		const { container } = render(
			<QueryBuilderFunnelChart data={funnelDropoffSampleData} variant="dropoff" showStepPercent />,
		)
		expect(container.textContent).toContain("4m")
		expect(container.querySelector("[data-slot='funnel-dropoff-tooltip']")).toBeNull()

		const steps = container.querySelectorAll("[data-slot='funnel-dropoff-step']")
		fireEvent.pointerEnter(steps[1]!)
		const tip = container.querySelector("[data-slot='funnel-dropoff-tooltip']")
		expect(tip).not.toBeNull()
		const tipText = tip?.textContent ?? ""
		expect(tipText).toContain("Dropped here went to")
		// `''` is labelled, not printed empty; shares are of everyone who dropped (2,710).
		expect(tipText).toContain("Nothing after")
		expect(tipText).toContain("44%")
		expect(tipText).toContain("/docs/quickstart")
		expect(tipText).toContain("p50 4m · p90 1h")
	})

	it("hovering step 1 opens nothing — there is no previous step to have dropped from", () => {
		const { container } = render(
			<QueryBuilderFunnelChart data={funnelDropoffSampleData} variant="dropoff" />,
		)
		fireEvent.pointerEnter(container.querySelectorAll("[data-slot='funnel-dropoff-step']")[0]!)
		expect(container.querySelector("[data-slot='funnel-dropoff-tooltip']")).toBeNull()
	})

	it("is the empty state without rows, and stays the bar funnel without the variant", () => {
		const empty = render(<QueryBuilderFunnelChart data={[]} variant="dropoff" />)
		expect(empty.container.textContent).toContain("No data")
		cleanup()
		const bars = render(<QueryBuilderFunnelChart data={stages} />)
		expect(bars.container.querySelector("[data-slot='funnel-dropoff']")).toBeNull()
	})
})
