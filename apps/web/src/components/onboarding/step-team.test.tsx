// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import { StepTeam } from "./step-team"
import { OnboardingTeamError } from "./team-actions"

afterEach(cleanup)

it("keeps a failed invite editable, supports retry, and prevents duplicate invitations", async () => {
	const invite = vi
		.fn()
		.mockReturnValueOnce(
			Effect.fail(
				new OnboardingTeamError({
					operation: "invite",
					message: "Please retry the invitation.",
					cause: null,
				}),
			),
		)
		.mockReturnValue(Effect.void)
	render(
		<StepTeam
			initialName="Engineering"
			actions={{ rename: () => Effect.void, invite }}
			onBack={() => {}}
			onContinue={() => {}}
		/>,
	)
	const input = screen.getByLabelText(/Invite a teammate/)
	fireEvent.change(input, { target: { value: "teammate@example.com" } })
	fireEvent.click(screen.getByRole("button", { name: "Send invitation" }))
	expect(await screen.findByText("Please retry the invitation.")).toBeTruthy()
	expect((input as HTMLInputElement).value).toBe("teammate@example.com")
	fireEvent.click(screen.getByRole("button", { name: "Send invitation" }))
	expect(await screen.findByText("Invitation sent to teammate@example.com.")).toBeTruthy()
	fireEvent.change(input, { target: { value: "TEAMMATE@example.com" } })
	expect(screen.getByRole("button", { name: "Send invitation" }).hasAttribute("disabled")).toBe(true)
	expect(invite).toHaveBeenCalledTimes(2)
})

it("lets a solo user continue without renaming or inviting", () => {
	const rename = vi.fn()
	const invite = vi.fn()
	const onContinue = vi.fn()
	render(
		<StepTeam
			initialName="Engineering"
			actions={{ rename, invite }}
			onBack={() => {}}
			onContinue={onContinue}
		/>,
	)
	fireEvent.click(screen.getByRole("button", { name: "Continue to plans" }))
	expect(onContinue).toHaveBeenCalledOnce()
	expect(rename).not.toHaveBeenCalled()
	expect(invite).not.toHaveBeenCalled()
})

it("disables navigation and duplicate submissions while an invitation is sending", async () => {
	let finish: (() => void) | undefined
	const invite = vi.fn(() =>
		Effect.promise(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		),
	)
	render(
		<StepTeam
			initialName="Engineering"
			actions={{ rename: () => Effect.void, invite }}
			onBack={() => {}}
			onContinue={() => {}}
		/>,
	)
	fireEvent.change(screen.getByLabelText(/Invite a teammate/), {
		target: { value: "teammate@example.com" },
	})
	fireEvent.click(screen.getByRole("button", { name: "Send invitation" }))
	expect(screen.getByRole("button", { name: "Sending…" }).hasAttribute("disabled")).toBe(true)
	expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true)
	await waitFor(() => expect(finish).toBeDefined())
	finish?.()
	expect(await screen.findByText("Invitation sent to teammate@example.com.")).toBeTruthy()
	expect(invite).toHaveBeenCalledOnce()
})
