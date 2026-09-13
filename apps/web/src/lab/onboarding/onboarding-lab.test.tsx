// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { afterEach, expect, it, vi } from "vitest"
import { OnboardingLab } from "./onboarding-lab"

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

it("runs onboarding through simulated checkout and restarts without account API calls", async () => {
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
	const router = createRouter({
		routeTree: createRootRoute({ component: OnboardingLab }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	})
	await router.load()
	render(<RouterProvider router={router} />)
	fireEvent.click(await screen.findByRole("radio", { name: "Backend engineer" }))
	fireEvent.click(screen.getByRole("button", { name: /Continue/ }))
	fireEvent.click(await screen.findByRole("checkbox", { name: "Traces" }))
	fireEvent.click(screen.getByRole("checkbox", { name: "Errors" }))
	expect(screen.getByText("2 selected")).toBeTruthy()
	fireEvent.click(screen.getByRole("button", { name: "Continue" }))
	await screen.findByLabelText("Workspace name")
	fireEvent.click(screen.getByRole("button", { name: "Back" }))
	expect(((await screen.findByRole("checkbox", { name: "Traces" })) as HTMLInputElement).checked).toBe(true)
	expect((screen.getByRole("checkbox", { name: "Errors" }) as HTMLInputElement).checked).toBe(true)
	fireEvent.click(screen.getByRole("button", { name: "Continue" }))
	fireEvent.change(await screen.findByLabelText("Workspace name"), {
		target: { value: "Acme Engineering" },
	})
	fireEvent.click(screen.getByRole("button", { name: "Save name" }))
	expect(await screen.findByText("Workspace name saved. Make yourself at home.")).toBeTruthy()
	fireEvent.change(screen.getByLabelText(/Invite a teammate/), {
		target: { value: "teammate@example.com" },
	})
	fireEvent.click(screen.getByRole("button", { name: "Send invitation" }))
	expect(await screen.findByText("Invitation sent to teammate@example.com.")).toBeTruthy()
	fireEvent.click(screen.getByRole("button", { name: "Continue to plans" }))
	fireEvent.click(await screen.findByRole("button", { name: "Start 14-day trial" }))
	expect(await screen.findByRole("heading", { name: "Preview complete" })).toBeTruthy()
	fireEvent.click(screen.getByRole("button", { name: "Try it again" }))
	const role = (await screen.findByRole("radio", { name: "Backend engineer" })) as HTMLInputElement
	expect(role.checked).toBe(false)
	expect(screen.getByRole("button", { name: /Continue/ }).hasAttribute("disabled")).toBe(true)
	// App telemetry can flush while the lab runs; onboarding must never hit
	// account, demo-seeding, or billing APIs.
	const accountRequests = fetch.mock.calls.filter(([input]) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
		return !(url.hostname === "ingest.maple.dev" && url.pathname.startsWith("/v1/"))
	})
	expect(accountRequests).toHaveLength(0)
})
