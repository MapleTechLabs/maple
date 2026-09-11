// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { DetectedModel } from "@/hooks/use-detected-models"
import { ModelLabel, modelTitle } from "./model-label"

afterEach(cleanup)

const resolved: DetectedModel = {
	model: "anthropic/claude-sonnet-4-5-20250929",
	displayName: "Claude Sonnet 4.5",
	vendorSlug: "anthropic",
	vendorName: "Anthropic",
	brandColor: { light: "#D97757", dark: "#D97757" },
	family: "claude",
}

// What the hook hands back before the batch lands, and for a model no catalog
// knows: the shape is the same, so the label branches on nothing.
const unresolved: DetectedModel = {
	model: "azure/my-deployment",
	displayName: "my-deployment",
	vendorSlug: null,
	vendorName: null,
	brandColor: null,
	family: null,
}

describe("ModelLabel", () => {
	it("names the model and draws a mark beside it", () => {
		const { container } = render(<ModelLabel detected={resolved} />)

		expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy()
		expect(container.querySelector("svg")).toBeTruthy()
	})

	it("draws the same shape for a model nothing resolved, so the row does not reflow", () => {
		const { container } = render(<ModelLabel detected={unresolved} />)

		expect(screen.getByText("my-deployment")).toBeTruthy()
		expect(container.querySelector("svg")).toBeTruthy()
	})

	it("counts the models a lane has no room for, outside the truncating name", () => {
		render(<ModelLabel detected={resolved} moreCount={4} />)

		expect(screen.getByText("+4")).toBeTruthy()
	})

	it("says the vendor and the id the span reported, and defers to a caller's title", () => {
		expect(modelTitle(resolved)).toBe("Anthropic · anthropic/claude-sonnet-4-5-20250929")
		expect(modelTitle(unresolved)).toBe("azure/my-deployment")

		const { container } = render(<ModelLabel detected={resolved} title="gpt-4o, claude-opus-5" />)
		expect(container.querySelector("[title]")?.getAttribute("title")).toBe("gpt-4o, claude-opus-5")
	})

	it("leaves the title off for a caller that names the model in its own tooltip", () => {
		const { container } = render(<ModelLabel detected={resolved} title={null} />)
		expect(container.querySelector("[title]")).toBeNull()
	})
})
