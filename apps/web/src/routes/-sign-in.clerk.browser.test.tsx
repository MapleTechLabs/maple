// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

describe("SignInPage (clerk mode)", () => {
	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
		vi.resetModules()
	})

	it("renders Clerk sign-in when Clerk auth mode is enabled", async () => {
		vi.doMock("@/lib/services/common/auth-mode", () => ({
			isClerkAuthEnabled: true,
		}))
		vi.doMock("@clerk/clerk-react", () => ({
			SignIn: () => <div>Clerk Sign In</div>,
		}))

		const module = await import("./sign-in")
		const { component: SignInPage } = await import("./sign-in?tsr-split=component")

		// SignInPage reads redirect_url via Route.useSearch(), which needs a live
		// router — stub it since this test renders the page standalone.
		vi.spyOn(module.Route, "useSearch").mockReturnValue({ redirect_url: undefined })
		vi.spyOn(module.Route, "useLoaderData").mockReturnValue({ previewSignIn: false })

		render(<SignInPage />)

		expect(screen.getByText("Clerk Sign In")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Sign in to preview" })).toBeNull()
		// The two dynamic imports pull the route's whole module graph in cold, which
		// overruns the 5s default when the suite shares the machine with turbo's
		// typecheck/build tasks.
	}, 30_000)

	it("trades the preview access key for a Clerk ticket", async () => {
		const fetchSpy = vi
			.spyOn(window, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ ticket: "tkt_123" }), { status: 200 }))
		const { PreviewAccessForm } = await import("./sign-in")
		const onTicket = vi.fn()

		render(<PreviewAccessForm onTicket={onTicket} />)
		fireEvent.change(screen.getByLabelText("Access key"), { target: { value: " shared-key " } })
		fireEvent.click(screen.getByRole("button", { name: "Sign in to preview" }))

		await waitFor(() => expect(onTicket).toHaveBeenCalledWith("tkt_123"))
		const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/api/auth/preview/sign-in"))
		expect(call?.[1]?.body).toBe(JSON.stringify({ key: "shared-key" }))
	}, 30_000)

	it("shows the API's message for a wrong key", async () => {
		vi.spyOn(window, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "Invalid preview access key" }), { status: 401 }),
		)
		const { PreviewAccessForm } = await import("./sign-in")
		const onTicket = vi.fn()

		render(<PreviewAccessForm onTicket={onTicket} />)
		fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "nope" } })
		fireEvent.click(screen.getByRole("button", { name: "Sign in to preview" }))

		expect((await screen.findByRole("alert")).textContent).toBe("Invalid preview access key")
		expect(onTicket).not.toHaveBeenCalled()
	}, 30_000)
})
