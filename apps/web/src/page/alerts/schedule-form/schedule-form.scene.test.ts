import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { OnCallScheduleId, UserId } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import {
	checkoutOverrides,
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

const memberNameOf = (index: number) => oncallMembers[index]?.name ?? ""

/** The saved checkout schedule cut down to one weeknights layer, so its days and weekends are gaps. */
const weeknightsOnly = (model: Model) =>
	run(model, [
		Message.ClickedRemoveLayer({ key: "l2" }),
		Message.ClickedRemoveLayer({ key: "l1" }),
		Message.ClickedAddRestriction({ key: "l0" }),
	])

const overridesFailure = {
	_tag: "@maple/http/errors/AlertPersistenceError",
	type: "api_error",
	code: "persistence_error",
	title: "Couldn't read",
	message: "Couldn't read the overrides",
	retryable: false,
	recovery: "retry",
} as const

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
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("button", { name: `Move ${oncallMembers[2]?.name} up in layer 1` })).toExist(),
			expectView(role("button", { name: `Remove ${oncallMembers[2]?.name} in layer 1` })).toExist(),
		)
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

	test("UTC can be picked although the browser's zone list leaves it out", () => {
		const model = run(ready(), [
			Message.ReadDefaults({
				timeZone: "Europe/Berlin",
				nowMs: ONCALL_NOW,
				zones: ["Europe/Berlin", "America/New_York"],
			}),
			Message.GotZoneMessage({ message: { _tag: "ClickedItem", value: "UTC" } }),
		])
		expect(model.form.timeZone).toBe("UTC")
	})

	test("a new zone keeps each layer's start on the wall clock shown, and saves it in that zone", () => {
		const base = ready()
		const loaded = run({ ...base, editingId: Schema.decodeSync(OnCallScheduleId)(scheduleUuid(1)) }, [])
		const filled = { ...loaded, form: formFromSchedule(checkoutSchedule(ONCALL_NOW)) }
		const shown = filled.form.layers[0]?.startsAt ?? ""
		const moved = run(filled, [
			Message.GotZoneMessage({ message: { _tag: "ClickedItem", value: "America/New_York" } }),
		])
		expect(moved.form.layers[0]?.startsAt).toBe(shown)
		expect(Option.map(payloadOf(moved.form), (payload) => payload.layers[0].starts_at)).toEqual(
			Option.map(localInputMs(shown, "America/New_York"), (ms) => new Date(ms).toISOString()),
		)
	})

	test("a window whose From and To are the same time saves as a full day, and says so", () => {
		const model = run(ready(), [
			Message.ChangedName({ value: "Checkout primary" }),
			addPerson("l0", 0),
			Message.ClickedAddRestriction({ key: "l0" }),
			Message.ChangedRestrictionTime({ key: "l0", restrictionKey: "r1", edge: "end", value: "18:00" }),
		])
		expect(
			Option.map(payloadOf(model.form), (payload) => payload.layers[0].restrictions?.[0]?.end_time),
		).toEqual(Option.some("18:00"))
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Runs 24 hours, to the same time the next day")).toExist(),
			expectView(role("button", { name: "Remove this window from layer 1" })).toExist(),
			expectView(role("group", { name: "Days of window 1 in layer 1" })).toExist(),
			expectView(role("group", { name: "Rotation in layer 1" })).toExist(),
			expectView(text("Ends the next morning")).not.toExist(),
		)
	})

	test("a start before 1970 is refused, as the API refuses it", () => {
		expect(localInputMs("1969-12-31T23:00", "UTC")).toEqual(Option.none())
		expect(localInputMs("1970-01-01T00:00", "UTC")).toEqual(Option.some(0))
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

	describe("coverage preview", () => {
		test("a layer with nobody in it leaves the next 14 days uncovered and says why", () => {
			scene(
				{ update: pageUpdate, view },
				given(ready()),
				expectView(text("Primary has no people, so it covers nothing.")).toExist(),
				expectView(text("Nobody is on call for the next 14 days")).toExist(),
				expectView(text("Add people to see shifts")).toExist(),
				// One gap that is the whole range has no link of its own.
				expectView(role("button", { name: /^From /u })).not.toExist(),
				expectView(role("img", { name: "No one on call from Tue 10 Nov 11:30" })).toExist(),
			)
		})

		test("adding a person updates the preview to covered, and a restriction opens gaps", () => {
			const staffed = run(ready(), [addPerson("l0", 0)])
			scene(
				{ update: pageUpdate, view },
				given(staffed),
				expectView(text("Covered for the next 14 days")).toExist(),
				// A new layer starts today at 09:00, which is not worth a note even after 09:00.
				expectView(text(/started before today/u)).not.toExist(),
				expectView(role("rowheader", { name: /Final schedule/u })).toExist(),
			)
			// Weeknights only (18:00 to 08:00): days and weekends are gaps.
			const nights = run(staffed, [Message.ClickedAddRestriction({ key: "l0" })])
			scene(
				{ update: pageUpdate, view },
				given(nights),
				expectView(
					text(
						"10 gaps in the next 14 days, longest 2d 10h (Sat 14 Nov 08:00 to Mon 16 Nov 18:00)",
					),
				).toExist(),
				expectView(role("button", { name: "Sat 14 Nov 08:00 to Mon 16 Nov 18:00" })).toExist(),
			)
			const focus = pageUpdate(nights, Message.ClickedPreviewGap({ index: 4 }))
			expect(names(focus.commands)).toEqual(["FocusCoverageGap"])
		})

		test("a window with no days stops the layer previewing instead of reading as always active", () => {
			const nights = run(ready(), [addPerson("l0", 0), Message.ClickedAddRestriction({ key: "l0" })])
			const noDays = run(
				nights,
				Arr.map(["mon", "tue", "wed", "thu", "fri"] as const, (weekday) =>
					Message.ToggledRestrictionDay({ key: "l0", restrictionKey: "r1", weekday }),
				),
			)
			scene(
				{ update: pageUpdate, view },
				given(noDays),
				expectView(text("Fix this layer to see shifts")).toExist(),
				expectView(text("Nobody is on call for the next 14 days")).toExist(),
				expectView(text("Covered for the next 14 days")).not.toExist(),
			)
		})

		test("a new schedule started on an earlier day says the rotation is under way and who has it", () => {
			// Two people, daily at 09:00 from Sun 8 Nov: by Tue 10 Nov 11:30 it is the first one's turn again.
			const early = run(ready(), [
				addPerson("l0", 0),
				addPerson("l0", 1),
				Message.PickedRotation({ key: "l0", rotation: "daily" }),
				Message.ChangedLayerText({ key: "l0", field: "startsAt", value: "2026-11-08T09:00" }),
			])
			scene(
				{ update: pageUpdate, view },
				given(early),
				expectView(
					text(
						`Primary started before today, so the rotation is already under way: ${memberNameOf(0)} is on call now.`,
					),
				).toExist(),
			)
			// A saved schedule always started in the past: no note for it.
			scene(
				{ update: pageUpdate, view },
				given(ready({ scheduleId: schedulePublicId(1) })),
				expectView(text(/started before today/u)).not.toExist(),
			)
		})

		test("a draft has no past: Previous is off from today", () => {
			const model = ready()
			scene(
				{ update: pageUpdate, view },
				given(model),
				expectView(role("button", { name: "Previous week" })).toBeDisabled(),
			)
			expect(pageUpdate(model, Message.ClickedPreviewPrevious()).model.previewWeekOffset).toBe(0)
			const later = run(model, [Message.ClickedPreviewNext()])
			scene(
				{ update: pageUpdate, view },
				given(later),
				expectView(role("button", { name: "Previous week" })).not.toBeDisabled(),
			)
		})

		test("the range switch and week steps change what the preview covers", () => {
			const staffed = run(ready(), [addPerson("l0", 0), Message.PickedPreviewRange({ days: "7" })])
			scene(
				{ update: pageUpdate, view },
				given(staffed),
				expectView(text("Covered for the next 7 days")).toExist(),
				expectView(text("10 Nov to 16 Nov")).toExist(),
			)
			const later = run(staffed, [Message.ClickedPreviewNext()])
			scene(
				{ update: pageUpdate, view },
				given(later),
				expectView(text("Covered in this period")).toExist(),
				expectView(text("17 Nov to 23 Nov")).toExist(),
			)
			expect(run(later, [Message.ClickedPreviewToday()]).previewWeekOffset).toBe(0)
		})
	})

	describe("overrides in the preview of a saved schedule", () => {
		test("an edit reads the schedule's overrides; a new schedule asks for none", () => {
			expect(names(init({ _tag: "AlertsScheduleNew", search: {} }, context).commands)).not.toContain(
				"FetchScheduleFormOverrides",
			)
			expect(
				names(
					init({ _tag: "AlertsScheduleNew", search: { scheduleId: schedulePublicId(1) } }, context)
						.commands,
				),
			).toContain("FetchScheduleFormOverrides")
			// A new schedule's preview does not wait on anything.
			scene(
				{ update: pageUpdate, view },
				given(run(ready(), [addPerson("l0", 0)])),
				expectView(text("Covered for the next 14 days")).toExist(),
			)
		})

		test("until the overrides land the timeline is a skeleton and nothing is said about gaps", () => {
			scene(
				{ update: pageUpdate, view },
				given(weeknightsOnly(ready({ scheduleId: schedulePublicId(1) }))),
				expectView(text("Coverage preview")).toExist(),
				expectView(role("rowheader", { name: /Final schedule/u })).not.toExist(),
				expectView(text(/gaps? in the next/u)).not.toExist(),
				expectView(text(/^Covered/u)).not.toExist(),
				expectView(text(/^Nobody is on call/u)).not.toExist(),
			)
		})

		test("an override covering part of a gap fills it, as it does when paging", () => {
			const editing = weeknightsOnly(ready({ scheduleId: schedulePublicId(1) }))
			// Dana Kim covers Fri 13 Nov 12:00 to Sat 14 Nov 12:00, over the Friday and weekend gaps.
			const loaded = run(editing, [
				Message.CompletedFetchOverrides({
					key: editing.overrides.key ?? "",
					result: Result.succeed(checkoutOverrides(ONCALL_NOW)),
				}),
			])
			scene(
				{ update: pageUpdate, view },
				given(loaded),
				expectView(
					role("img", { name: "Override: Dana Kim, Fri 13 Nov, 12:00 to Sat 14 Nov, 12:00" }),
				).toExist(),
				expectView(role("button", { name: "Fri 13 Nov 08:00 to 12:00" })).toExist(),
				expectView(role("button", { name: "Fri 13 Nov 08:00 to 18:00" })).not.toExist(),
				expectView(role("button", { name: "Sat 14 Nov 12:00 to Mon 16 Nov 18:00" })).toExist(),
				// The first weekend is partly covered now, so the second is the longest gap.
				expectView(
					text(
						"10 gaps in the next 14 days, longest 2d 10h (Sat 21 Nov 08:00 to Mon 23 Nov 18:00)",
					),
				).toExist(),
				expectView(text(/Overrides are not shown/u)).not.toExist(),
				expectView(text(/Overrides could not be loaded/u)).not.toExist(),
			)
		})

		test("a failed overrides read previews without them, says so and offers another try", () => {
			const editing = weeknightsOnly(ready({ scheduleId: schedulePublicId(1) }))
			const failed = run(editing, [
				Message.CompletedFetchOverrides({
					key: editing.overrides.key ?? "",
					result: Result.fail(overridesFailure),
				}),
			])
			scene(
				{ update: pageUpdate, view },
				given(failed),
				expectView(text(/Overrides could not be loaded, so gaps may be filled\./u)).toExist(),
				expectView(role("button", { name: "Try again" })).not.toBeDisabled(),
				expectView(role("button", { name: "Fri 13 Nov 08:00 to 18:00" })).toExist(),
				expectView(role("img", { name: /^Override:/u })).not.toExist(),
			)
			const retried = pageUpdate(failed, Message.ClickedRetryOverrides())
			expect(names(retried.commands)).toEqual(["FetchScheduleFormOverrides"])
			// The note stays up while the retry is out, with its link off.
			scene(
				{ update: pageUpdate, view },
				given(retried.model),
				expectView(text(/Overrides could not be loaded/u)).toExist(),
				expectView(role("button", { name: "Try again" })).toBeDisabled(),
			)
			const recovered = run(retried.model, [
				Message.CompletedFetchOverrides({
					key: retried.model.overrides.key ?? "",
					result: Result.succeed(checkoutOverrides(ONCALL_NOW)),
				}),
			])
			scene(
				{ update: pageUpdate, view },
				given(recovered),
				expectView(text(/Overrides could not be loaded/u)).not.toExist(),
				expectView(role("button", { name: "Fri 13 Nov 08:00 to 12:00" })).toExist(),
			)
		})
	})
})
