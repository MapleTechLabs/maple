// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { MessageResponse } from "./message-response"

const fence = (body: string) => ["```chart", body, "```"].join("\n")

const CHART = fence(
	JSON.stringify({
		type: "area",
		title: "Errors per minute",
		unit: "number",
		data: [
			{ bucket: "2026-09-11T10:00:00Z", series: { "checkout-api": 4 } },
			{ bucket: "2026-09-11T10:01:00Z", series: { "checkout-api": 31 } },
		],
	}),
)

afterEach(cleanup)

it("renders a chart fence as a titled figure rather than a code block", async () => {
	render(<MessageResponse>{CHART}</MessageResponse>)
	const figure = await screen.findByRole("figure")
	expect(figure.textContent).toContain("Errors per minute")
	expect(document.querySelector("pre")).toBeNull()
})

it("leaves a fence that is not a chart visible as text", async () => {
	render(<MessageResponse>{fence('{"type":"line","data":"soon"}')}</MessageResponse>)
	const block = await screen.findByText(/"type":"line"/)
	expect(block).toBeTruthy()
	expect(screen.queryByRole("figure")).toBeNull()
})
