import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { defaultRuleForm, type RuleFormState } from "@/lib/alerts/form-utils"
import { describeRuleCondition, RuleConditionFields } from "./rule-condition-bar"

afterEach(cleanup)

function Harness({ initial }: { initial: RuleFormState }) {
	const [form, setForm] = useState(initial)
	return (
		<>
			<RuleConditionFields form={form} onChange={setForm} saved={null} />
			<output>{describeRuleCondition(form)}</output>
		</>
	)
}

describe("RuleConditionFields tiers", () => {
	it("adds a critical tier one step past the warning threshold, and removes it again", () => {
		render(<Harness initial={defaultRuleForm()} />)

		fireEvent.click(screen.getByRole("button", { name: "Add critical tier" }))
		expect(screen.getByLabelText("Critical threshold")).toHaveProperty("value", "10")
		expect(screen.getByRole("status").textContent).toContain("critical above 10%")

		fireEvent.click(screen.getByRole("button", { name: "Remove" }))
		expect(screen.queryByLabelText("Critical threshold")).toBeNull()
		expect(screen.getByRole("button", { name: "Add critical tier" })).toBeTruthy()
	})

	it("offers no critical tier or recovery value on a range condition", () => {
		render(<Harness initial={{ ...defaultRuleForm(), comparator: "between", thresholdUpper: "9" }} />)

		expect(screen.queryByRole("button", { name: "Add critical tier" })).toBeNull()
		expect(screen.queryByLabelText("Recovers below")).toBeNull()
	})
})

describe("RuleConditionFields check cadence", () => {
	it("says how often the window is checked as the window changes", () => {
		render(<Harness initial={defaultRuleForm()} />)
		const window = screen.getByLabelText("Window")

		fireEvent.change(window, { target: { value: "5" } })
		expect(screen.getByText(/checked every minute\./)).toBeTruthy()

		fireEvent.change(window, { target: { value: "15" } })
		expect(screen.getByText(/checked every 3 min\./)).toBeTruthy()

		fireEvent.change(window, { target: { value: "60" } })
		expect(screen.getByText(/checked every 5 min\./)).toBeTruthy()
	})
})
