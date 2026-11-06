import { Option, Array as Arr, Schema } from "effect"
import { AlertDestinationId } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import { chainDestinationUuid, chainOf } from "../shared/escalation-test-fixtures"
import { init, Message, type Model, openEdit, payloadOf, update } from "./dialog"

const asDestination = Schema.decodeSync(AlertDestinationId)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => update(current, message).model)
const opened = (): Model =>
	openEdit(
		init("chain"),
		chainOf({
			n: 1,
			name: "Checkout on-call",
			steps: [
				{ destinations: [1], wait: 10 },
				{ destinations: [2], wait: 15 },
			],
			repeat: 1,
		}),
	).model

describe("escalation chain dialog", () => {
	it("an edited chain round-trips to the payload it was read from", () => {
		expect(payloadOf(opened())).toEqual(
			Option.some({
				name: "Checkout on-call",
				description: null,
				steps: [
					{
						targets: [{ type: "destination", destination_id: chainDestinationUuid(1) }],
						wait_minutes: 10,
					},
					{
						targets: [{ type: "destination", destination_id: chainDestinationUuid(2) }],
						wait_minutes: 15,
					},
				],
				repeat_count: 1,
			}),
		)
	})

	it("holds the API's limits: a name, a destination per step, a 1 to 1440 minute wait, 0 to 5 repeats", () => {
		const model = opened()
		const key = model.steps[0]?.key ?? ""
		const broken = (messages: ReadonlyArray<Message>) => Option.isNone(payloadOf(run(model, messages)))
		expect(broken([Message.ChangedName({ value: "  " })])).toBe(true)
		expect(broken([Message.ChangedWait({ key, value: "0" })])).toBe(true)
		expect(broken([Message.ChangedWait({ key, value: "1441" })])).toBe(true)
		expect(broken([Message.ChangedWait({ key, value: "2.5" })])).toBe(true)
		expect(broken([Message.ChangedRepeatCount({ value: "6" })])).toBe(true)
		expect(
			broken([Message.ClickedRemoveDestination({ key, id: asDestination(chainDestinationUuid(1)) })]),
		).toBe(true)
		expect(
			broken([Message.ChangedWait({ key, value: "1440" }), Message.ChangedRepeatCount({ value: "5" })]),
		).toBe(false)
	})

	it("a save with errors sends nothing and shows them; a valid one sends once", () => {
		const model = run(opened(), [Message.ChangedName({ value: "" })])
		const refused = update(model, Message.ClickedSave())
		expect(refused.commands ?? []).toEqual([])
		expect(refused.model.isShowingErrors).toBe(true)
		const saving = update(opened(), Message.ClickedSave())
		expect(Arr.map(saving.commands ?? [], ({ name }) => name)).toEqual(["SaveEscalationChain"])
		expect(update(saving.model, Message.ClickedSave()).commands ?? []).toEqual([])
	})

	it("steps reorder up and down, add up to ten, and the last one cannot move further", () => {
		const model = opened()
		const [first, second] = model.steps
		const moved = run(model, [Message.ClickedMoveStep({ key: first?.key ?? "", direction: "down" })])
		expect(Arr.map(moved.steps, (step) => step.key)).toEqual([second?.key, first?.key])
		expect(
			run(moved, [Message.ClickedMoveStep({ key: first?.key ?? "", direction: "down" })]).steps,
		).toEqual(moved.steps)
		const full = run(
			model,
			Arr.makeBy(12, () => Message.ClickedAddStep()),
		)
		expect(full.steps).toHaveLength(10)
	})
})
