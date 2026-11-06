import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { OnCallScheduleId, UserId } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import {
	checkoutSchedule,
	memberId,
	ONCALL_NOW,
	oncallMembers,
	schedulePublicId,
	scheduleUuid,
} from "../shared/oncall-test-fixtures"
import { ORG } from "../shared/test-rows"
import { formFromSchedule, localInputMs, localInputOf, payloadOf } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const ENGINEER = Policy.grantsOf(["org:engineer"])
const ZONES = ["UTC", "Europe/Berlin", "America/New_York"]

const ready = (search: { scheduleId?: string } = {}) => {
	const entered = init({ _tag: "AlertsScheduleNew", search }, context)
	const base = run(entered.model, [
		Message.ReadDefaults({ timeZone: "Europe/Berlin", nowMs: ONCALL_NOW, zones: ZONES }),
		Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
		Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
	])
	return search.scheduleId === undefined
		? base
		: run(base, [
				Message.CompletedFetchExisting({
					key: base.existing.key ?? "",
					result: Result.succeed(checkoutSchedule(ONCALL_NOW)),
				}),
			])
}

const addPerson = (key: string, index: number) =>
	Message.GotParticipantMenuMessage({
		key,
		message: { _tag: "ClickedItem", index, item: { kind: "Item", value: memberId(index) } },
	})

describe("schedule form", () => {
	test("a new schedule starts on the viewer's zone, today at 09:00, with one weekly layer", () => {
		const model = ready()
		expect(model.form.timeZone).toBe("Europe/Berlin")
		expect(model.form.layers).toHaveLength(1)
		expect(model.form.layers[0]?.startsAt).toBe("2026-11-10T09:00")
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("New schedule")).toExist(),
			expectView(role("combobox", { name: "Time zone" })).toExist(),
			expectView(text("Nobody yet. Add who takes turns.")).toExist(),
		)
	})

	test("an edited schedule fills the form and saves back the layers it was read with", () => {
		const schedule = checkoutSchedule(ONCALL_NOW)
		const model = ready({ scheduleId: schedulePublicId(1) })
		expect(model.form).toEqual(formFromSchedule(schedule))
		const payload = payloadOf(model.form)
		expect(Option.map(payload, (p) => p.layers)).toEqual(Option.some(schedule.layers))
		expect(Option.map(payload, (p) => p.time_zone)).toEqual(Option.some("Europe/Berlin"))
	})

	test("a start reads on the schedule's wall clock, across a DST change", () => {
		expect(localInputMs("2026-10-25T09:00", "Europe/Berlin")).toEqual(
			Option.some(Date.parse("2026-10-25T08:00:00.000Z")),
		)
		expect(localInputMs("2026-10-24T09:00", "Europe/Berlin")).toEqual(
			Option.some(Date.parse("2026-10-24T07:00:00.000Z")),
		)
		expect(localInputMs("tomorrow", "Europe/Berlin")).toEqual(Option.none())
	})

	test("saving with what the API refuses shows each problem and sends nothing", () => {
		const model = run(ready(), [
			Message.ChangedLayerText({ key: "l0", field: "handoffTime", value: "25:00" }),
			Message.ClickedAddRestriction({ key: "l0" }),
			...Arr.map(["mon", "tue", "wed", "thu", "fri"] as const, (weekday) =>
				Message.ToggledRestrictionDay({ key: "l0", restrictionKey: "r1", weekday }),
			),
		])
		const step = pageUpdate(model, Message.ClickedSave())
		expect(names(step.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			expectView(text("Name the schedule")).toExist(),
			expectView(text("Add at least one person")).toExist(),
			expectView(text("Use an HH:MM handoff time")).toExist(),
			expectView(text("Pick at least one day")).toExist(),
		)
	})

	test("people rotate in the order picked, and move up and down", () => {
		const model = run(ready(), [
			Message.ChangedName({ value: "Checkout primary" }),
			addPerson("l0", 0),
			addPerson("l0", 1),
			addPerson("l0", 2),
			Message.ClickedMoveParticipant({
				key: "l0",
				userId: Schema.decodeSync(UserId)(memberId(2)),
				direction: "up",
			}),
		])
		expect(model.form.layers[0]?.participants).toEqual([memberId(0), memberId(2), memberId(1)])
		expect(names(pageUpdate(model, Message.ClickedSave()).commands)).toEqual(["SaveOnCallSchedule"])
	})

	test("a refused save keeps the form and says why", () => {
		const saving = pageUpdate(run(ready({ scheduleId: schedulePublicId(1) }), []), Message.ClickedSave())
		expect(names(saving.commands)).toEqual(["SaveOnCallSchedule"])
		const failed = pageUpdate(
			saving.model,
			Message.CompletedSave({
				result: Result.fail({
					_tag: "@maple/http/errors/AlertValidationError",
					type: "invalid_request_error",
					code: "invalid_request",
					title: "Invalid request",
					message: "Omar Haddad is no longer a member of this organization.",
					retryable: false,
					recovery: "fix_request",
				}),
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			expectView(text("Couldn't save the schedule")).toExist(),
			expectView(text("Omar Haddad is no longer a member of this organization.")).toExist(),
		)
	})

	test("layers draw top first, and Move up on the bottom layer makes it the top one in the saved payload", () => {
		const model = run(ready(), [
			Message.ChangedName({ value: "Checkout" }),
			addPerson("l0", 0),
			Message.ClickedAddLayer(),
			addPerson("l1", 1),
			Message.ChangedLayerText({ key: "l1", field: "name", value: "Nights" }),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("button", { name: "Move layer 1 up" })).toExist(),
			expectView(text("Layer 2, on top")).toExist(),
			expectView(text("Layer 1, at the bottom")).toExist(),
		)
		const raised = run(model, [Message.ClickedMoveLayer({ key: "l0", direction: "up" })])
		expect(
			Option.map(payloadOf(raised.form), (payload) => Arr.map(payload.layers, (layer) => layer.name)),
		).toEqual(Option.some(["Nights", "Primary"]))
	})

	test("a window's midnight note waits until both times are complete", () => {
		const model = run(ready(), [Message.ClickedAddRestriction({ key: "l0" })])
		scene({ update: pageUpdate, view }, given(model), expectView(text("Ends the next morning")).toExist())
		scene(
			{ update: pageUpdate, view },
			given(
				run(model, [
					Message.ChangedRestrictionTime({
						key: "l0",
						restrictionKey: "r1",
						edge: "end",
						value: "",
					}),
				]),
			),
			expectView(text("Ends the next morning")).not.toExist(),
			expectView(text("Same day")).not.toExist(),
		)
	})

	test("an edit sends a layer's saved start back exactly, seconds and a repeated DST hour included, until its text changes", () => {
		const schedule = checkoutSchedule(ONCALL_NOW)
		const repeatedHour = "2026-10-25T01:30:15.000Z" // 02:30:15 CET, after Berlin fell back
		const edited = {
			...schedule,
			layers: Arr.map(schedule.layers, (layer, index) =>
				index === 0 ? { ...layer, starts_at: repeatedHour } : layer,
			),
		}
		const base = ready()
		const loaded = run({ ...base, editingId: Schema.decodeSync(OnCallScheduleId)(scheduleUuid(1)) }, [])
		const filled = { ...loaded, form: formFromSchedule(edited) }
		expect(Option.map(payloadOf(filled.form), (payload) => payload.layers[0].starts_at)).toEqual(
			Option.some(repeatedHour),
		)
		const retyped = run(filled, [
			Message.ChangedLayerText({ key: "l0", field: "startsAt", value: "2026-10-26T09:00" }),
		])
		expect(Option.map(payloadOf(retyped.form), (payload) => payload.layers[0].starts_at)).toEqual(
			Option.some("2026-10-26T08:00:00.000Z"),
		)
	})

	test("a start before year 1000 keeps four year digits", () => {
		expect(localInputOf(Date.UTC(999, 0, 2, 9, 0), "UTC")).toBe("0999-01-02T09:00")
	})

	test("a failed load of the edited schedule offers Try again, which reads it again", () => {
		const entered = init(
			{ _tag: "AlertsScheduleNew", search: { scheduleId: schedulePublicId(1) } },
			context,
		)
		const failed = run(entered.model, [
			Message.ReadDefaults({ timeZone: "Europe/Berlin", nowMs: ONCALL_NOW, zones: ZONES }),
			Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
			Message.CompletedFetchExisting({
				key: entered.model.existing.key ?? "",
				result: Result.fail({
					_tag: "@maple/http/errors/AlertPersistenceError",
					type: "api_error",
					code: "persistence_error",
					title: "Couldn't read",
					message: "Couldn't read the schedule",
					retryable: false,
					recovery: "retry",
				}),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(role("button", { name: /Try again/u })).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetryExisting()).commands)).toContain(
			"FetchScheduleFormSchedule",
		)
	})
})
