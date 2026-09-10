// @vitest-environment jsdom

import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import type { OnboardingIntent } from "@/lib/onboarding-intent"
import { StepIntent } from "./step-intent"

afterEach(cleanup)

function IntentHarness() {
	const [value, onChange] = useState<readonly OnboardingIntent[]>([])
	return <StepIntent value={value} onChange={onChange} onBack={() => {}} onContinue={() => {}} />
}

it("supports multiple independent choices and disables continue only when none are selected", () => {
	render(<IntentHarness />)
	const choices = screen.getAllByRole("checkbox") as HTMLInputElement[]
	const next = screen.getByRole("button", { name: "Continue" })
	expect(next.hasAttribute("disabled")).toBe(true)
	choices.forEach((choice) => fireEvent.click(choice))
	expect(choices.every((choice) => choice.checked)).toBe(true)
	expect(choices).toHaveLength(8)
	expect(screen.getByText("8 selected")).toBeTruthy()
	expect(next.hasAttribute("disabled")).toBe(false)
	fireEvent.click(choices[0])
	expect(choices[0].checked).toBe(false)
	expect(choices.slice(1).every((choice) => choice.checked)).toBe(true)
	choices.slice(1).forEach((choice) => fireEvent.click(choice))
	expect(next.hasAttribute("disabled")).toBe(true)
})
