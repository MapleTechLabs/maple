// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { afterEach, expect, it } from "vitest"

import { ProvideKnownServices } from "./known-services"
import { MessageResponse } from "./message-response"

afterEach(cleanup)

const TABLE = [
	"| Trace ID | Root Span | Duration | Service | Error |",
	"| --- | --- | --- | --- | --- |",
	"| b02eadc6551920cb1bae8554b498a7c2 | HTTP POST | 4672.46s (~78 min) | dashboard | no |",
	"| 1a8b248fe7f4d1ff66208744950b5fd5 | HTTP GET | 12ms | unreported | yes |",
].join("\n")

async function renderTable() {
	const router = createRouter({
		routeTree: createRootRoute({
			component: () => (
				<ProvideKnownServices services={new Set(["dashboard"])}>
					<MessageResponse>{TABLE}</MessageResponse>
				</ProvideKnownServices>
			),
		}),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	})
	await router.load()
	render(<RouterProvider router={router} />)
	return await screen.findByRole("table")
}

it("links every trace id and only the services the org reports", async () => {
	await renderTable()
	expect(screen.getByRole("link", { name: "b02eadc6551920cb1bae8554b498a7c2" }).getAttribute("href")).toBe(
		"/traces/b02eadc6551920cb1bae8554b498a7c2",
	)
	expect(screen.getByRole("link", { name: "dashboard" }).getAttribute("href")).toBe("/services/dashboard")
	expect(screen.queryByRole("link", { name: "unreported" })).toBeNull()
	expect(screen.queryByRole("link", { name: "HTTP POST" })).toBeNull()
})

it("tones a duration by magnitude and an error flag by its column", async () => {
	await renderTable()
	expect(screen.getByText("4672.46s").className).toContain("text-severity-error")
	expect(screen.getByText("12ms").className).toContain("text-muted-foreground")
	expect(screen.getByText("no").className).toContain("text-muted-foreground")
	expect(screen.getByText("yes").className).toContain("text-severity-error")
})

it("leaves a link the model wrote itself exactly as authored", async () => {
	const table = [
		"| Trace ID | Service |",
		"| --- | --- |",
		"| [b02eadc6551920cb1bae8554b498a7c2](https://example.test/t) | dashboard |",
	].join("\n")
	const router = createRouter({
		routeTree: createRootRoute({
			component: () => (
				<ProvideKnownServices services={new Set(["dashboard"])}>
					<MessageResponse>{table}</MessageResponse>
				</ProvideKnownServices>
			),
		}),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	})
	await router.load()
	render(<RouterProvider router={router} />)
	const rendered = await screen.findByRole("table")
	// Streamdown renders an outbound link as its own confirm control, so the
	// assertion is that the authored element survived, not that an anchor exists.
	expect(rendered.querySelector('[data-streamdown="link"]')?.textContent).toBe(
		"b02eadc6551920cb1bae8554b498a7c2",
	)
	expect(screen.queryByRole("link", { name: "b02eadc6551920cb1bae8554b498a7c2" })).toBeNull()
})
