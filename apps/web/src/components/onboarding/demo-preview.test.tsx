// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { DemoPreview } from "./demo-preview"

afterEach(cleanup)

it("lets a visitor discover the bottleneck and keep exploring", () => {
	render(<DemoPreview />)
	const payment = screen.getByRole("button", { name: "payments.charge, 470 ms, slow span" })
	const cache = screen.getByRole("button", { name: "cache.write, 50 ms" })

	expect(payment.getAttribute("aria-pressed")).toBe("false")
	fireEvent.click(payment)
	expect(payment.getAttribute("aria-pressed")).toBe("true")
	expect(
		screen.getByText("Found it. Your first slow span.").closest("[aria-live]")?.getAttribute("aria-live"),
	).toBe("polite")

	fireEvent.click(cache)
	expect(payment.getAttribute("aria-pressed")).toBe("false")
	expect(cache.getAttribute("aria-pressed")).toBe("true")
	expect(screen.getByText("A short cache write at the end of the request.")).toBeTruthy()
	expect(screen.queryByText("Found it. Your first slow span.")).toBeNull()
})
