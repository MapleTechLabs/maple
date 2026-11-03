import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { applyStepEdit, StepEdit, stepControlId, stepEditOf, type StepDraft } from "./funnel-steps"

const steps: ReadonlyArray<StepDraft> = [
	{ kind: "session", dimension: "referrerHost", value: "google.com" },
	{ kind: "event", eventName: "signup_completed" },
]

describe("applyStepEdit", () => {
	test("a session step moved below step 1 becomes an empty event step", () => {
		expect(applyStepEdit(steps, StepEdit.Moved({ index: 0, delta: 1 }), 10)).toEqual([
			{ kind: "event", eventName: "signup_completed" },
			{ kind: "event", eventName: "" },
		])
	})

	test("adding stops at the step limit", () => {
		expect(applyStepEdit(steps, StepEdit.Added(), 2)).toBe(steps)
		expect(applyStepEdit(steps, StepEdit.Added(), 3)).toHaveLength(3)
	})

	test("an emptied page host drops the key", () => {
		const page: ReadonlyArray<StepDraft> = [{ kind: "page", pagePath: "/", host: "maple.dev" }]
		expect(applyStepEdit(page, StepEdit.ChangedText({ index: 0, field: "host", value: "" }), 10)).toEqual(
			[{ kind: "page", pagePath: "/" }],
		)
	})
})

describe("stepEditOf", () => {
	test("a control's value comes back as its builder's edit", () => {
		expect(stepEditOf(stepControlId("funnel", 2, "eventName"), "query_run")).toEqual(
			Option.some({
				scope: "funnel",
				edit: StepEdit.ChangedText({ index: 2, field: "eventName", value: "query_run" }),
			}),
		)
		expect(stepEditOf(stepControlId("paths", 0, "kind"), "page")).toEqual(
			Option.some({ scope: "paths", edit: StepEdit.SetKind({ index: 0, kind: "page" }) }),
		)
	})

	test("a control id works as a CSS id selector, which the combobox anchors its list with", () => {
		expect(stepControlId("funnel", 3, "pagePath")).toMatch(/^[A-Za-z][\w-]*$/)
	})

	test("an unknown kind or another control's id is no edit", () => {
		expect(Option.isNone(stepEditOf(stepControlId("funnel", 0, "kind"), "span"))).toBe(true)
		expect(Option.isNone(stepEditOf("key-by:funnel", "person"))).toBe(true)
	})
})
