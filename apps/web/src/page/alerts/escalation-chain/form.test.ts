import { Option, Array as Arr, Schema } from "effect"
import { AlertDestinationId, MAX_ESCALATION_STEPS } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import { chainSummary, safeReturnTo } from "../shared/escalation-chains"
import { chainDestinationUuid, chainOf } from "../shared/escalation-test-fixtures"
import { mixedTargetChain } from "../shared/oncall-test-fixtures"
import {
	addTarget,
	duplicateStep,
	emptyForm,
	type Form,
	formFromChain,
	formIssues,
	insertStep,
	moveStep,
	payloadOf,
	previewOf,
	removeStep,
	repeatError,
	waitError,
} from "./form"

const asDestination = Schema.decodeSync(AlertDestinationId)
const destination = (n: number) => ({
	type: "destination" as const,
	destination_id: asDestination(chainDestinationUuid(n)),
})
const keys = (form: Form) => Arr.map(form.steps, (step) => step.key)

const loaded = (): Form =>
	formFromChain(
		chainOf({
			n: 1,
			name: "Checkout on-call",
			steps: [
				{ destinations: [1], wait: 10 },
				{ destinations: [2], wait: 15 },
			],
			repeat: 1,
		}),
	)

describe("escalation chain form", () => {
	it("an edited chain round-trips to the payload it was read from", () => {
		expect(payloadOf(loaded())).toEqual(
			Option.some({
				name: "Checkout on-call",
				description: null,
				steps: [
					{ targets: [destination(1)], wait_minutes: 10 },
					{ targets: [destination(2)], wait_minutes: 15 },
				],
				repeat_count: 1,
			}),
		)
	})

	it("keeps a chain's people and schedules through a load", () => {
		const chain = mixedTargetChain(chainDestinationUuid(1))
		expect(Option.map(payloadOf(formFromChain(chain)), (payload) => payload.steps)).toEqual(
			Option.some(chain.steps),
		)
	})

	it("a new form has no payload until it is named and its step pages someone", () => {
		expect(payloadOf(emptyForm)).toEqual(Option.none())
		expect(formIssues(emptyForm)).toEqual([
			"Name the chain",
			"Pick at least one destination, person or schedule",
		])
		const ready = addTarget({ ...emptyForm, name: "On-call" }, "s0", destination(1))
		expect(Option.isSome(payloadOf(ready))).toBe(true)
	})

	it("rejects waits and repeats outside the API's limits", () => {
		expect(Option.isSome(waitError("0"))).toBe(true)
		expect(Option.isSome(waitError("2000"))).toBe(true)
		expect(Option.isSome(waitError(""))).toBe(true)
		expect(waitError("10")).toEqual(Option.none())
		expect(Option.isSome(repeatError("-1"))).toBe(true)
		expect(repeatError("0")).toEqual(Option.none())
	})

	it("inserts a step where the + was pressed, each with its own key", () => {
		const form = loaded()
		const between = insertStep(form, 1)
		expect(keys(between)).toEqual(["s0", "s2", "s1"])
		expect(keys(insertStep(between, 0))).toEqual(["s3", "s0", "s2", "s1"])
		expect(keys(insertStep(form, 2))).toEqual(["s0", "s1", "s2"])
	})

	it("stops adding steps at the API's limit", () => {
		const full = Arr.reduce(Arr.range(1, MAX_ESCALATION_STEPS + 2), emptyForm, (form) =>
			insertStep(form, form.steps.length),
		)
		expect(full.steps.length).toBe(MAX_ESCALATION_STEPS)
		expect(duplicateStep(full, "s0").steps.length).toBe(MAX_ESCALATION_STEPS)
	})

	it("moves, duplicates and removes steps, keeping at least one", () => {
		const form = loaded()
		expect(keys(moveStep(form, "s1", "up"))).toEqual(["s1", "s0"])
		expect(keys(moveStep(form, "s0", "up"))).toEqual(["s0", "s1"])
		const copied = duplicateStep(form, "s0")
		expect(keys(copied)).toEqual(["s0", "s2", "s1"])
		expect(copied.steps[1]?.targets).toEqual(form.steps[0]?.targets)
		expect(keys(removeStep(form, "s0"))).toEqual(["s1"])
		expect(keys(removeStep(removeStep(form, "s0"), "s1"))).toEqual(["s1"])
	})

	it("adds a target to a step once", () => {
		const twice = addTarget(addTarget(emptyForm, "s0", destination(1)), "s0", destination(1))
		expect(twice.steps[0]?.targets).toEqual([destination(1)])
	})

	it("previews the chain as it reads elsewhere, skipping steps that page no one yet", () => {
		const names = (id: string) =>
			id === chainDestinationUuid(1) ? "Slack #alerts-api" : "PagerDuty Checkout"
		const form = insertStep({ ...loaded(), repeatCount: "2" }, 1)
		expect(chainSummary(previewOf(form), names)).toBe(
			"Slack #alerts-api, then PagerDuty Checkout after 10m; repeats twice",
		)
		expect(previewOf(emptyForm).steps).toEqual([])
	})

	it("follows only an in-app returnTo", () => {
		expect(safeReturnTo("/alerts/rules/abc")).toEqual(Option.some("/alerts/rules/abc"))
		expect(safeReturnTo("https://evil.example")).toEqual(Option.none())
		expect(safeReturnTo("//evil.example")).toEqual(Option.none())
		expect(safeReturnTo("/\\evil.example")).toEqual(Option.none())
		expect(safeReturnTo(undefined)).toEqual(Option.none())
	})
})
