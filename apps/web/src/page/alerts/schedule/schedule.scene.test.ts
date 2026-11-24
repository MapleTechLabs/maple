import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { OnCallOverrideId, OnCallScheduleId } from "@maple/domain/http"
import { zonedDayStart } from "@maple/views/ui/shift-timeline"
import { Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { msIso } from "../../kit/alert-time"
import { memberName } from "../shared/org-members"
import { editScheduleHref, formatShiftEdge } from "../shared/oncall-schedules"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import {
	checkoutCalendarFeed,
	checkoutOverrides,
	checkoutSchedule,
	checkoutShifts,
	DST_NOW,
	formerMemberId,
	memberId,
	ONCALL_NOW,
	oncallMembers,
	overrideUuid,
	schedulePublicId,
	scheduleUuid,
} from "../shared/oncall-test-fixtures"
import { ORG } from "../../kit/alert-test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, overrideIssue, rangeOf, readRangeOf, update } from "./update"
import { view as pageView } from "./view"
import { toEpochMs } from "@maple/ui/lib/time-format"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])
const BERLIN = "Europe/Berlin"

const loaded = (nowMs: number, grants = ENGINEER, departed: ReadonlyArray<string> = []) => {
	const entered = init({ _tag: "AlertsSchedule", scheduleId: schedulePublicId(1), search: {} }, context)
	expect(names(entered.commands)).toEqual(
		expect.arrayContaining(["FetchOnCallSchedule", "FetchOnCallOverrides", "FetchScheduleMembers"]),
	)
	const base = run(entered.model, [
		Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
		Message.CompletedFetchSession({ orgId: ORG, grants }),
		Message.ReadClock({ nowMs }),
		Message.CompletedFetchSchedule({
			key: entered.model.schedule.key ?? "",
			readAtMs: nowMs,
			result: Result.succeed(checkoutSchedule(nowMs, departed)),
		}),
		Message.CompletedFetchOverrides({
			key: entered.model.overrides.key ?? "",
			result: Result.succeed(checkoutOverrides(nowMs)),
		}),
	])
	return withShifts(base, nowMs)
}

/** The shifts the page asked for, over the range it asked for (wider than the week drawn). */
const withShifts = (model: Model, nowMs: number) =>
	Option.match(readRangeOf(model), {
		onNone: () => model,
		onSome: ({ fromMs, toMs }) =>
			run(model, [
				Message.CompletedFetchShifts({
					key: model.shifts.key ?? "",
					result: Result.succeed(checkoutShifts(nowMs, fromMs, toMs)),
				}),
			]),
	})

const commandArgs = (
	commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined,
	name: string,
) =>
	Arr.findFirst(commands ?? [], (command) => command.name === name).pipe(
		Option.map((command) => command.args),
	)

describe("on-call schedule page", () => {
	test("the week reads each layer and the final row in the schedule's zone, noting the viewer's", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW)),
			expectView(text("Checkout primary")).toExist(),
			expectView(
				text("Your time zone is UTC. Pick a shift in the final row to cover it with an override."),
			).toExist(),
			expectView(role("rowheader", { name: /Final schedule/u })).toExist(),
			expectView(role("rowheader", { name: /Weeknights/u })).toExist(),
			expectView(role("button", { name: /^Override: Ana Souza, Wed,? 11 Nov/u })).toExist(),
			expectView(text("Upcoming overrides")).toExist(),
			expectView(role("button", { name: /^Delete Dana Kim's override, /u })).toExist(),
		)
	})

	test("participants who left are named, with what happens to their shifts and a link to edit the rotation", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW, ENGINEER, [memberId(0), formerMemberId])),
			expectView(text("Ben Brook and a former member left the org")).toExist(),
			expectView(
				text(/Their shifts pass to the next person in the rotation who is still in the org/u),
			).toExist(),
			expectView(role("link", { name: "Edit the schedule" })).toHaveAttr(
				"href",
				editScheduleHref(Schema.decodeSync(OnCallScheduleId)(scheduleUuid(1))),
			),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW, ENGINEER, [formerMemberId])),
			expectView(text("A former member left the org")).toExist(),
		)
	})

	test("a schedule whose participants are all members says nothing about anyone leaving", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW)),
			expectView(text(/left the org/u)).not.toExist(),
			expectView(text(/Their shifts pass/u)).not.toExist(),
		)
	})

	test("a member who cannot edit is told who can take the departed out of the rotation", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW, MEMBER, [formerMemberId])),
			expectView(text("A former member left the org")).toExist(),
			expectView(text(/An org admin or engineer can edit the schedule/u)).toExist(),
			expectView(role("link", { name: "Edit the schedule" })).not.toExist(),
		)
	})

	test("the calendar's heading carries the whole schedule name as its title, for a name too long to show", () => {
		const entered = init({ _tag: "AlertsSchedule", scheduleId: schedulePublicId(1), search: {} }, context)
		const name = `checkout-primary-${Str.repeat(120)("x")}`
		const long = run(entered.model, [
			Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
			Message.ReadClock({ nowMs: ONCALL_NOW }),
			Message.CompletedFetchSchedule({
				key: entered.model.schedule.key ?? "",
				readAtMs: ONCALL_NOW,
				result: Result.succeed({ ...checkoutSchedule(ONCALL_NOW), name }),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(long),
			expectView(role("heading", { name: `Shifts for ${name}` })).toHaveAttr(
				"title",
				`Shifts for ${name}`,
			),
		)
	})

	test("the DST week runs Thursday to Wednesday on the Berlin clock, through the fall-back Sunday", () => {
		const model = loaded(DST_NOW)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Sun 25")).toExist(),
			expectView(text("22 Oct to 4 Nov")).toExist(),
		)
	})

	test("moving a week reads that week's shifts and shows a skeleton, not last week's bars, until they land", () => {
		const model = loaded(ONCALL_NOW)
		const next = pageUpdate(model, Message.ClickedNextWeek())
		expect(names(next.commands)).toEqual(["FetchOnCallShifts"])
		expect(next.model.weekOffset).toBe(1)
		scene(
			{ update: pageUpdate, view },
			given(next.model),
			expectView(text("17 Nov to 30 Nov")).toExist(),
			expectView(role("rowheader", { name: /Final schedule/u })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withShifts(next.model, ONCALL_NOW)),
			expectView(role("rowheader", { name: /Final schedule/u })).toExist(),
		)
		expect(pageUpdate(next.model, Message.ClickedThisWeek()).model.weekOffset).toBe(0)
	})

	test("an override over a shift crossing the week's edge covers the whole shift, not the drawn part", () => {
		const model = loaded(ONCALL_NOW)
		const weekEnd = Option.getOrElse(
			Option.map(rangeOf(model), (range) => range.toMs),
			() => 0,
		)
		const shifts = Option.getOrElse(AsyncData.getData(model.shifts.data), () => checkoutShifts(0, 0, 1))
		const crossing = Arr.findFirst(
			shifts.final,
			(shift) => toEpochMs(shift.starts_at) < weekEnd && toEpochMs(shift.ends_at) > weekEnd,
		)
		expect(Option.isSome(crossing)).toBe(true)
		const shift = Option.getOrElse(crossing, () => shifts.final[0])
		const created = pageUpdate(
			run(model, [
				Message.ClickedShift({
					startMs: toEpochMs(shift?.starts_at ?? ""),
					endMs: toEpochMs(shift?.ends_at ?? ""),
				}),
				Message.ChangedOverrideUser({ value: memberId(7) }),
			]),
			Message.ClickedCreateOverride(),
		)
		expect(commandArgs(created.commands, "CreateOnCallOverride")).toEqual(
			Option.some(
				expect.objectContaining({
					payload: { user_id: memberId(7), starts_at: shift?.starts_at, ends_at: shift?.ends_at },
				}),
			),
		)
	})

	test("an override opened on an instant with seconds sends that instant back while its text is untouched", () => {
		const startMs = Date.UTC(2026, 10, 12, 8, 0, 30)
		const opened = run(loaded(ONCALL_NOW), [
			Message.ClickedShift({ startMs, endMs: startMs + 3_600_000 }),
			Message.ChangedOverrideUser({ value: memberId(7) }),
		])
		const created = pageUpdate(opened, Message.ClickedCreateOverride())
		expect(commandArgs(created.commands, "CreateOnCallOverride")).toEqual(
			Option.some(
				expect.objectContaining({
					payload: expect.objectContaining({ starts_at: "2026-11-12T08:00:30.000Z" }),
				}),
			),
		)
		const edited = pageUpdate(
			run(opened, [Message.ChangedOverrideStart({ value: "2026-11-12T10:00" })]),
			Message.ClickedCreateOverride(),
		)
		expect(commandArgs(edited.commands, "CreateOnCallOverride")).toEqual(
			Option.some(
				expect.objectContaining({
					payload: expect.objectContaining({ starts_at: "2026-11-12T09:00:00.000Z" }),
				}),
			),
		)
	})

	test("the header's on-call is read again after its handoff passes, and after an override is written", () => {
		const model = loaded(ONCALL_NOW)
		const handoff = Option.getOrElse(
			Option.flatMap(AsyncData.getData(model.schedule.data), (schedule) =>
				Option.map(Option.fromNullishOr(schedule.on_call_now), (now) => toEpochMs(now.ends_at)),
			),
			() => 0,
		)
		expect(
			names(pageUpdate(model, Message.ReadClock({ nowMs: handoff - 60_000 })).commands),
		).not.toContain("FetchOnCallSchedule")
		expect(names(pageUpdate(model, Message.ReadClock({ nowMs: handoff })).commands)).toContain(
			"FetchOnCallSchedule",
		)
		const created = pageUpdate(
			run(model, [Message.ClickedNewOverride(), Message.ChangedOverrideUser({ value: memberId(7) })]),
			Message.ClickedCreateOverride(),
		)
		const done = pageUpdate(
			created.model,
			Message.CompletedCreateOverride({
				openCount: created.model.overrideOpenCount,
				result: Result.succeed(Option.getOrThrow(Arr.head(checkoutOverrides(ONCALL_NOW)))),
			}),
		)
		expect(names(done.commands)).toContain("FetchOnCallSchedule")
	})

	test("a failed header re-read keeps the last schedule and tries again on the five-minute clock", () => {
		const model = loaded(ONCALL_NOW)
		const handoff = Option.getOrElse(
			Option.flatMap(AsyncData.getData(model.schedule.data), (schedule) =>
				Option.map(Option.fromNullishOr(schedule.on_call_now), (now) => toEpochMs(now.ends_at)),
			),
			() => 0,
		)
		const asked = pageUpdate(model, Message.ReadClock({ nowMs: handoff }))
		expect(names(asked.commands)).toContain("FetchOnCallSchedule")
		const failed = pageUpdate(
			asked.model,
			Message.CompletedFetchSchedule({
				key: asked.model.schedule.key ?? "",
				readAtMs: handoff,
				result: Result.fail({
					_tag: "@maple/http/errors/AlertPersistenceError",
					type: "api_error",
					code: "persistence_error",
					title: "Couldn't read",
					message: "Couldn't read",
					retryable: true,
					recovery: "retry",
				}),
			}),
		).model
		expect(
			names(pageUpdate(failed, Message.ReadClock({ nowMs: handoff + 30_000 })).commands),
		).not.toContain("FetchOnCallSchedule")
		expect(
			names(pageUpdate(failed, Message.ReadClock({ nowMs: handoff + 6 * 60_000 })).commands),
		).toContain("FetchOnCallSchedule")
	})

	test("a failed shifts read waits for Try again instead of retrying every clock tick", () => {
		const model = loaded(ONCALL_NOW)
		const failed = run(model, [Message.ClickedNextWeek()])
		const settled = run(failed, [
			Message.CompletedFetchShifts({
				key: failed.shifts.key ?? "",
				result: Result.fail({
					_tag: "@maple/http/errors/AlertPersistenceError",
					type: "api_error",
					code: "persistence_error",
					title: "Couldn't read",
					message: "Couldn't read the schedule",
					retryable: true,
					recovery: "retry",
				}),
			}),
		])
		expect(
			names(pageUpdate(settled, Message.ReadClock({ nowMs: ONCALL_NOW + 30_000 })).commands),
		).not.toContain("FetchOnCallShifts")
		expect(names(pageUpdate(settled, Message.ClickedRetryShifts()).commands)).toContain(
			"FetchOnCallShifts",
		)
	})

	test("a final shift opens an override for its range; creating one sends the times in UTC", () => {
		const fromMs = zonedDayStart(ONCALL_NOW, BERLIN, 2)
		const opened = run(loaded(ONCALL_NOW), [
			Message.ClickedShift({ startMs: fromMs, endMs: fromMs + 8 * 3_600_000 }),
			Message.ChangedOverrideUser({ value: memberId(7) }),
		])
		expect(opened.overrideDraft.startsAt).toBe("2026-11-12T00:00")
		const created = pageUpdate(opened, Message.ClickedCreateOverride())
		expect(names(created.commands)).toEqual(["CreateOnCallOverride"])
	})

	test("an override has to end after it starts and in the future", () => {
		const draft = {
			userId: memberId(1),
			startsAt: "2026-11-12T10:00",
			endsAt: "2026-11-12T09:00",
			startMs: null,
			endMs: null,
		}
		expect(overrideIssue(draft, BERLIN, ONCALL_NOW)).toEqual(
			Option.some("End the override after it starts"),
		)
		expect(
			overrideIssue(
				{ ...draft, startsAt: "2026-11-01T08:00", endsAt: "2026-11-02T08:00" },
				BERLIN,
				ONCALL_NOW,
			),
		).toEqual(Option.some("End the override in the future"))
		expect(overrideIssue({ ...draft, userId: "" }, BERLIN, ONCALL_NOW)).toEqual(
			Option.some("Pick who covers the shift"),
		)
		expect(overrideIssue({ ...draft, endsAt: "2026-11-12T18:00" }, BERLIN, ONCALL_NOW)).toEqual(
			Option.none(),
		)
	})

	test("a failed overrides read offers Try again, which reads them again", () => {
		const entered = init({ _tag: "AlertsSchedule", scheduleId: schedulePublicId(1), search: {} }, context)
		const failed = run(entered.model, [
			Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
			Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
			Message.ReadClock({ nowMs: ONCALL_NOW }),
			Message.CompletedFetchSchedule({
				key: entered.model.schedule.key ?? "",
				readAtMs: ONCALL_NOW,
				result: Result.succeed(checkoutSchedule(ONCALL_NOW)),
			}),
			Message.CompletedFetchOverrides({
				key: entered.model.overrides.key ?? "",
				result: Result.fail({
					_tag: "@maple/http/errors/AlertPersistenceError",
					type: "api_error",
					code: "persistence_error",
					title: "Couldn't read",
					message: "Couldn't read",
					retryable: false,
					recovery: "retry",
				}),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(withShifts(failed, ONCALL_NOW)),
			expectView(text("Couldn't load the overrides")).toExist(),
			expectView(role("button", { name: /Try again/u })).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetryOverrides()).commands)).toContain(
			"FetchOnCallOverrides",
		)
	})

	test("each override's delete button names the window it removes", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW)),
			expectView(role("button", { name: /^Delete .+'s override, .+/u })).toExist(),
		)
	})

	test("deleting an override asks first, sends one delete, and reads the list again even when it fails", () => {
		const overrideId = Schema.decodeSync(OnCallOverrideId)(overrideUuid(1))
		const asked = pageUpdate(loaded(ONCALL_NOW), Message.ClickedDeleteOverride({ overrideId }))
		expect(names(asked.commands)).not.toContain("DeleteOnCallOverride")
		expect(asked.model.confirmDeleteOverrideId).toBe(overrideId)
		const confirmed = pageUpdate(asked.model, Message.ClickedConfirmDeleteOverride())
		expect(names(confirmed.commands)).toContain("DeleteOnCallOverride")
		expect(
			names(pageUpdate(confirmed.model, Message.ClickedConfirmDeleteOverride()).commands),
		).not.toContain("DeleteOnCallOverride")
		const gone = pageUpdate(
			confirmed.model,
			Message.CompletedDeleteOverride({
				overrideId,
				result: Result.fail({
					_tag: "@maple/http/errors/OnCallOverrideNotFoundError",
					type: "not_found_error",
					code: "oncall_override_not_found",
					title: "Override not found",
					message: "The override no longer exists.",
					retryable: false,
					recovery: "fix_request",
				}),
			}),
		)
		expect(names(gone.commands)).toContain("FetchOnCallOverrides")
		expect(names(gone.commands)).toContain("FetchOnCallShifts")
	})

	test("a member reads the calendar and sees adding, editing and deleting locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW, MEMBER)),
			expectView(role("button", { name: "Add override" })).toBeDisabled(),
			expectView(role("button", { name: "Edit schedule" })).toBeDisabled(),
			expectView(role("button", { name: /^Delete Dana Kim's override, /u })).toBeDisabled(),
			expectView(role("group", { name: Policy.denialFor("oncall:manage").message })).toExist(),
			expectView(text("Your time zone is UTC.")).toExist(),
		)
	})

	test("an ended shift is a read-only bar; a running one opens an override from now to its real end", () => {
		const model = loaded(ONCALL_NOW)
		const shifts = Option.getOrThrow(AsyncData.getData(model.shifts.data))
		const weekStart = Option.getOrElse(
			Option.map(rangeOf(model), (range) => range.fromMs),
			() => 0,
		)
		const ended = Option.getOrThrow(
			Arr.findFirst(
				shifts.final,
				(shift) => toEpochMs(shift.starts_at) >= weekStart && toEpochMs(shift.ends_at) <= ONCALL_NOW,
			),
		)
		const running = Option.getOrThrow(
			Arr.findFirst(
				shifts.final,
				(shift) => toEpochMs(shift.starts_at) <= ONCALL_NOW && ONCALL_NOW < toEpochMs(shift.ends_at),
			),
		)
		const endedName = `${memberName(oncallMembers, ended.user_id)}, ${formatShiftEdge(toEpochMs(ended.starts_at), BERLIN)} to ${formatShiftEdge(toEpochMs(ended.ends_at), BERLIN)}`
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("img", { name: endedName })).toExist(),
			expectView(role("button", { name: endedName })).not.toExist(),
		)
		const ignored = pageUpdate(
			model,
			Message.ClickedShift({ startMs: toEpochMs(ended.starts_at), endMs: toEpochMs(ended.ends_at) }),
		)
		expect(ignored.model.overrideOpenCount).toBe(model.overrideOpenCount)
		const opened = run(model, [
			Message.ClickedShift({
				startMs: toEpochMs(running.starts_at),
				endMs: toEpochMs(running.ends_at),
			}),
			Message.ChangedOverrideUser({ value: memberId(7) }),
		])
		expect(overrideIssue(opened.overrideDraft, BERLIN, ONCALL_NOW)).toEqual(Option.none())
		expect(
			commandArgs(pageUpdate(opened, Message.ClickedCreateOverride()).commands, "CreateOnCallOverride"),
		).toEqual(
			Option.some(
				expect.objectContaining({
					payload: { user_id: memberId(7), starts_at: msIso(ONCALL_NOW), ends_at: running.ends_at },
				}),
			),
		)
	})
	test("the override form says the members did not load, rather than asking to pick nobody", () => {
		const model = run(loaded(ONCALL_NOW), [
			Message.CompletedFetchMembers({ result: Result.fail("Clerk is down") }),
			Message.ClickedNewOverride(),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Couldn't load members, try reloading the page")).toExist(),
		)
	})

	test("the calendar summarises coverage like the editor, with a range switch that reads the new range", () => {
		const model = loaded(ONCALL_NOW)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Covered in this period")).toExist(),
			expectView(role("group", { name: "Range" })).toExist(),
		)
		const month = pageUpdate(model, Message.PickedRange({ days: "28" }))
		expect(names(month.commands)).toEqual(["FetchOnCallShifts"])
		expect(Option.map(rangeOf(month.model), (r) => Math.round((r.toMs - r.fromMs) / 86_400_000))).toEqual(
			Option.some(28),
		)
		scene(
			{ update: pageUpdate, view },
			given(withShifts(month.model, ONCALL_NOW)),
			expectView(text("10 Nov to 7 Dec")).toExist(),
		)
	})

	test("a wider range draws a skeleton, not the old shifts as one long gap, until its shifts land", () => {
		const model = loaded(ONCALL_NOW)
		const month = pageUpdate(model, Message.PickedRange({ days: "28" }))
		scene(
			{ update: pageUpdate, view },
			given(month.model),
			expectView(text("10 Nov to 7 Dec")).toExist(),
			expectView(role("rowheader", { name: /Final schedule/u })).not.toExist(),
			expectView(text(/gap/u)).not.toExist(),
			expectView(text(/^Covered/u)).not.toExist(),
		)
	})

	test("a range that has wholly passed says its gaps are not checked, not that it was covered", () => {
		const before = pageUpdate(
			pageUpdate(loaded(ONCALL_NOW), Message.ClickedPreviousWeek()).model,
			Message.ClickedPreviousWeek(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withShifts(before.model, ONCALL_NOW)),
			expectView(text("27 Oct to 9 Nov")).toExist(),
			expectView(text("Past shifts. Gaps are only checked from now.")).toExist(),
			expectView(text(/^Covered/u)).not.toExist(),
		)
	})

	test("a gap in the summary focuses its bar on the calendar", () => {
		const focus = pageUpdate(loaded(ONCALL_NOW), Message.ClickedGap({ index: 0 }))
		expect(names(focus.commands)).toEqual(["FocusCoverageGap"])
	})
})
describe("on-call schedule page, calendar feed", () => {
	const feedOnSince = msIso(ONCALL_NOW - 12 * 86_400_000)
	/** The loaded page over a schedule whose calendar link was made twelve days ago. */
	const withFeedOn = () => {
		const page = loaded(ONCALL_NOW)
		return run(page, [
			Message.CompletedFetchSchedule({
				key: page.schedule.key ?? "",
				readAtMs: ONCALL_NOW,
				result: Result.succeed(checkoutSchedule(ONCALL_NOW, [], feedOnSince)),
			}),
		])
	}

	test("a schedule without a feed offers one link to make, and a member sees it locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW)),
			expectView(text("Calendar feed")).toExist(),
			expectView(text(/anyone who has it can see who is on call/u)).toExist(),
			expectView(role("button", { name: "Create calendar link" })).toExist(),
			expectView(role("button", { name: "Replace link" })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW, MEMBER)),
			expectView(role("button", { name: "Create calendar link" })).toBeDisabled(),
		)
	})

	test("making the link sends one request and shows the link once, with replace and turn off", () => {
		const page = loaded(ONCALL_NOW)
		const clicked = pageUpdate(page, Message.ClickedCreateCalendarFeed())
		expect(names(clicked.commands)).toEqual(["CreateOnCallCalendarFeed"])
		// A second click while the request runs sends nothing.
		expect(pageUpdate(clicked.model, Message.ClickedCreateCalendarFeed()).commands ?? []).toHaveLength(0)

		const feed = checkoutCalendarFeed(ONCALL_NOW)
		const made = pageUpdate(
			clicked.model,
			Message.CompletedCreateCalendarFeed({ result: Result.succeed(feed) }),
		)
		expect(made.outMessage).toMatchObject({ _tag: "RequestedToast", type: "success" })
		scene(
			{ update: pageUpdate, view },
			given(made.model),
			expectView(role("textbox")).toHaveValue(feed.url),
			expectView(text(/is not shown again/u)).toExist(),
			expectView(role("button", { name: "Replace link" })).toExist(),
			expectView(role("button", { name: "Turn off" })).toExist(),
			expectView(role("button", { name: "Create calendar link" })).not.toExist(),
		)

		const failed = pageUpdate(
			clicked.model,
			Message.CompletedCreateCalendarFeed({
				result: Result.fail({
					_tag: "@maple/http/errors/AlertPersistenceError",
					type: "api_error",
					code: "persistence_error",
					title: "Couldn't write",
					message: "Couldn't write",
					retryable: true,
					recovery: "retry",
				}),
			}),
		)
		expect(failed.outMessage).toMatchObject({
			_tag: "RequestedToast",
			title: "Couldn't create the calendar link",
		})
		expect(failed.model.isChangingCalendarFeed).toBe(false)
		expect(failed.model.calendarFeed).toBeNull()
	})

	test("a feed that is on says since when, never the link, and asks before replacing or turning off", () => {
		const on = withFeedOn()
		scene(
			{ update: pageUpdate, view },
			given(on),
			expectView(text(/^A calendar link was made on /u)).toExist(),
			expectView(role("textbox")).not.toExist(),
		)
		// Replace opens the question; nothing is sent until it is confirmed.
		const asked = pageUpdate(on, Message.ClickedReplaceCalendarFeed())
		expect(asked.model.calendarFeedDialog.isOpen).toBe(true)
		expect(names(asked.commands)).not.toContain("CreateOnCallCalendarFeed")
		expect(names(pageUpdate(asked.model, Message.ClickedConfirmCalendarFeed()).commands)).toEqual([
			"CreateOnCallCalendarFeed",
		])

		const turningOff = pageUpdate(on, Message.ClickedTurnOffCalendarFeed())
		const confirmed = pageUpdate(turningOff.model, Message.ClickedConfirmCalendarFeed())
		expect(names(confirmed.commands)).toEqual(["DeleteOnCallCalendarFeed"])
		const off = pageUpdate(
			confirmed.model,
			Message.CompletedDeleteCalendarFeed({ result: Result.succeed(undefined) }),
		)
		expect(off.model.calendarFeedDialog.isOpen).toBe(false)
		scene(
			{ update: pageUpdate, view },
			given(off.model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			// Shown as off before the schedule is read again.
			expectView(role("button", { name: "Create calendar link" })).toExist(),
			expectView(text(/^A calendar link was made on /u)).not.toExist(),
		)
	})
	test("leaving the question sends nothing, and it cannot be left while the change runs", () => {
		const on = withFeedOn()
		const dialog = (message: Dialog.Message) => Message.GotCalendarFeedDialogMessage({ message })
		const asked = pageUpdate(on, Message.ClickedReplaceCalendarFeed()).model
		// Escape and Close both leave: the question closes, nothing is sent, the feed is as it was.
		const escaped = pageUpdate(asked, dialog(Dialog.Message.PressedEscape()))
		const closed = pageUpdate(asked, dialog(Dialog.Message.ClickedClose()))
		expect([escaped.model.calendarFeedDialog.isOpen, closed.model.calendarFeedDialog.isOpen]).toEqual([
			false,
			false,
		])
		expect(names(escaped.commands)).not.toContain("CreateOnCallCalendarFeed")
		expect(names(closed.commands)).not.toContain("CreateOnCallCalendarFeed")
		expect(escaped.model.calendarFeed).toBeNull()
		// A confirm after leaving has no question to answer.
		expect(pageUpdate(escaped.model, Message.ClickedConfirmCalendarFeed()).commands ?? []).toHaveLength(0)

		// While the replace runs the question stays, so its answer is seen.
		const running = pageUpdate(asked, Message.ClickedConfirmCalendarFeed()).model
		const held = pageUpdate(running, dialog(Dialog.Message.PressedEscape())).model
		expect([held.calendarFeedDialog.isOpen, held.isChangingCalendarFeed]).toEqual([true, true])
	})

	test("a link someone else made since replaces what this page thought of the feed", () => {
		const page = loaded(ONCALL_NOW)
		const feed = checkoutCalendarFeed(ONCALL_NOW)
		const made = pageUpdate(
			page,
			Message.CompletedCreateCalendarFeed({ result: Result.succeed(feed) }),
		).model
		const reread = (createdAt: string | undefined) =>
			pageUpdate(
				made,
				Message.CompletedFetchSchedule({
					key: made.schedule.key ?? "",
					readAtMs: ONCALL_NOW,
					result: Result.succeed(checkoutSchedule(ONCALL_NOW, [], createdAt)),
				}),
			).model
		// The same link, read back: still shown.
		expect(reread(feed.created_at).calendarFeed?.url).toBe(feed.url)
		// A read that left before the link was made still says off: the link stays.
		expect(reread(undefined).calendarFeed?.url).toBe(feed.url)
		// Once a read has shown the link, a read that says off means someone turned it off.
		const confirmed = reread(feed.created_at)
		const turnedOffElsewhere = pageUpdate(
			confirmed,
			Message.CompletedFetchSchedule({
				key: confirmed.schedule.key ?? "",
				readAtMs: ONCALL_NOW,
				result: Result.succeed(checkoutSchedule(ONCALL_NOW, [], undefined)),
			}),
		).model
		expect(turnedOffElsewhere.calendarFeed).toBeNull()
		// Someone replaced it a minute later: this page's link is dead and no longer shown.
		expect(reread(msIso(ONCALL_NOW + 60_000)).calendarFeed).toBeNull()
	})

	test("a read that left before a replace does not take the new link off the page", () => {
		const on = withFeedOn()
		const asked = pageUpdate(on, Message.ClickedReplaceCalendarFeed())
		const confirmed = pageUpdate(asked.model, Message.ClickedConfirmCalendarFeed())
		const feed = checkoutCalendarFeed(ONCALL_NOW)
		const replaced = pageUpdate(
			confirmed.model,
			Message.CompletedCreateCalendarFeed({ result: Result.succeed(feed) }),
		).model
		const read = (key: string, createdAt: string) =>
			pageUpdate(
				replaced,
				Message.CompletedFetchSchedule({
					key,
					readAtMs: ONCALL_NOW,
					result: Result.succeed(checkoutSchedule(ONCALL_NOW, [], createdAt)),
				}),
			).model
		// Still showing the link this page just ended: an old answer, the new link stays.
		expect(read(replaced.schedule.key ?? "", feedOnSince).calendarFeed?.url).toBe(feed.url)
		// An answer to a request the page no longer waits for says nothing about the feed.
		expect(read("superseded", msIso(ONCALL_NOW + 60_000)).calendarFeed?.url).toBe(feed.url)
	})

	test("a create that finds someone else's link replaces nothing and shows theirs", () => {
		const page = loaded(ONCALL_NOW)
		const clicked = pageUpdate(page, Message.ClickedCreateCalendarFeed())
		// The create never asks to replace: only the confirmed question does.
		expect(clicked.commands?.[0]).toMatchObject({ args: { replace: false } })
		const refused = pageUpdate(
			clicked.model,
			Message.CompletedCreateCalendarFeed({
				result: Result.fail({
					_tag: "@maple/http/errors/OnCallCalendarFeedExistsError",
					type: "conflict_error",
					code: "oncall_calendar_feed_exists",
					title: "Calendar feed already has a link",
					message: "The schedule's calendar feed already has a link.",
					retryable: false,
					recovery: "fix_request",
				}),
			}),
		)
		expect(refused.outMessage).toMatchObject({
			_tag: "RequestedToast",
			title: "This schedule already has a calendar link",
		})
		// The schedule is read again, so the page shows the link that exists.
		expect(names(refused.commands)).toEqual(["FetchOnCallSchedule"])
		expect(refused.model.isChangingCalendarFeed).toBe(false)

		const on = withFeedOn()
		const asked = pageUpdate(on, Message.ClickedReplaceCalendarFeed())
		const confirmed = pageUpdate(asked.model, Message.ClickedConfirmCalendarFeed())
		expect(confirmed.commands?.[0]).toMatchObject({ args: { replace: true } })
	})
})
