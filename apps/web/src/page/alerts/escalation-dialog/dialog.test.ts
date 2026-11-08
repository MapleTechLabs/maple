import { Option, Array as Arr, Schema } from "effect"
import { AlertDestinationId } from "@maple/domain/http"
import * as Menu from "@maple/views/ui/menu"
import { describe, expect, it } from "vitest"
import { chainDestinationUuid, chainOf } from "../shared/escalation-test-fixtures"
import { memberId, mixedTargetChain, scheduleUuid } from "../shared/oncall-test-fixtures"
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

	it("a chain built through the API keeps its people and schedules through an edit", () => {
		const chain = mixedTargetChain(chainDestinationUuid(1))
		const model = openEdit(init("chain"), chain).model
		expect(Option.map(payloadOf(model), (payload) => payload.steps)).toEqual(Option.some(chain.steps))
		const key = model.steps[1]?.key ?? ""
		const removed = run(model, [
			Message.ClickedRemoveTarget({ key, target: `schedule:${scheduleUuid(1)}` }),
		])
		expect(Option.map(payloadOf(removed), (payload) => payload.steps[1]?.targets)).toEqual(
			Option.some([{ type: "user", user_id: memberId(1) }]),
		)
	})

	it("adds a person or a schedule from the step's menu, once each", () => {
		const model = opened()
		const key = model.steps[0]?.key ?? ""
		const pick = (value: string) =>
			Message.GotStepMenuMessage({
				key,
				message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value } }),
			})
		const added = run(model, [
			pick(`user:${memberId(3)}`),
			pick(`schedule:${scheduleUuid(2)}`),
			pick(`user:${memberId(3)}`),
		])
		expect(added.steps[0]?.targets).toEqual([
			{ type: "destination", destination_id: chainDestinationUuid(1) },
			{ type: "user", user_id: memberId(3) },
			{ type: "schedule", schedule_id: scheduleUuid(2) },
		])
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
			broken([
				Message.ClickedRemoveTarget({
					key,
					target: `destination:${asDestination(chainDestinationUuid(1))}`,
				}),
			]),
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

	it("edits sent while a save is in flight leave the form as it was sent", () => {
		const saving = update(opened(), Message.ClickedSave()).model
		const key = saving.steps[0]?.key ?? ""
		const edited = run(saving, [
			Message.ChangedName({ value: "Renamed mid-save" }),
			Message.ChangedDescription({ value: "typed while saving" }),
			Message.ChangedWait({ key, value: "30" }),
			Message.ChangedRepeatCount({ value: "3" }),
			Message.ClickedAddStep(),
			Message.ClickedRemoveStep({ key }),
			Message.ClickedMoveStep({ key, direction: "down" }),
			Message.ClickedRemoveTarget({
				key,
				target: `destination:${asDestination(chainDestinationUuid(1))}`,
			}),
		])
		expect(edited).toEqual(saving)
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

	it("an edit sends a step's member and schedule targets back, and a schedule alone is enough", () => {
		const chain = chainOf({
			n: 2,
			name: "Checkout on-call",
			steps: [
				{ destinations: [1], users: ["user_ben"], wait: 10 },
				{ destinations: [], schedules: [1], wait: 15 },
			],
		})
		const renamed = run(openEdit(init("chain"), chain).model, [
			Message.ChangedName({ value: "Checkout" }),
		])
		const saving = update(renamed, Message.ClickedSave())
		expect(saving.commands?.[0]?.args).toMatchObject({
			payload: {
				name: "Checkout",
				steps: Arr.map(chain.steps, (step) => ({ targets: step.targets })),
			},
		})
		const key = renamed.steps[0]?.key ?? ""
		const withoutDestination = run(renamed, [
			Message.ClickedRemoveTarget({
				key,
				target: `destination:${asDestination(chainDestinationUuid(1))}`,
			}),
		])
		expect(Option.map(payloadOf(withoutDestination), ({ steps }) => steps[0].targets)).toEqual(
			Option.some([{ type: "user", user_id: "user_ben" }]),
		)
	})
})
