import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { OnCallOverrideId } from "@maple/domain/http"
import { zonedDayStart } from "@maple/views/ui/shift-timeline"
import { Option, Result, Schema, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { isoMs, msIso } from "../shared/time"
import { memberName } from "../shared/org-members"
import { formatShiftEdge } from "../shared/oncall-schedules"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import {
	checkoutOverrides,
	checkoutSchedule,
	checkoutShifts,
	DST_NOW,
	memberId,
	ONCALL_NOW,
	oncallMembers,
	overrideUuid,
	schedulePublicId,
} from "../shared/oncall-test-fixtures"
import { ORG } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, overrideIssue, rangeOf, readRangeOf, update } from "./update"
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
const MEMBER = Policy.grantsOf(["org:member"])
const BERLIN = "Europe/Berlin"

const loaded = (nowMs: number, grants = ENGINEER) => {
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
			result: Result.succeed(checkoutSchedule(nowMs)),
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
				text(
					"Times in Europe/Berlin. Yours is UTC. Pick a shift in the final row to cover it with an override.",
				),
			).toExist(),
			expectView(role("rowheader", { name: /Final schedule/u })).toExist(),
			expectView(role("rowheader", { name: /Weeknights/u })).toExist(),
			expectView(role("button", { name: /^Override: Ana Souza, Wed,? 11 Nov/u })).toExist(),
			expectView(text("Upcoming overrides")).toExist(),
			expectView(role("button", { name: "Delete Dana Kim's override" })).toExist(),
		)
	})

	test("the DST week runs Thursday to Wednesday on the Berlin clock, through the fall-back Sunday", () => {
		const model = loaded(DST_NOW)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Sun 25")).toExist(),
			expectView(text("22 Oct to 28 Oct")).toExist(),
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
			expectView(text("17 Nov to 23 Nov")).toExist(),
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
			(shift) => isoMs(shift.starts_at) < weekEnd && isoMs(shift.ends_at) > weekEnd,
		)
		expect(Option.isSome(crossing)).toBe(true)
		const shift = Option.getOrElse(crossing, () => shifts.final[0])
		const created = pageUpdate(
			run(model, [
				Message.ClickedShift({
					startMs: isoMs(shift?.starts_at ?? ""),
					endMs: isoMs(shift?.ends_at ?? ""),
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
				Option.map(Option.fromNullishOr(schedule.on_call_now), (now) => isoMs(now.ends_at)),
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

	test("a member reads the calendar but cannot add or delete an override", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ONCALL_NOW, MEMBER)),
			expectView(role("button", { name: "Add override" })).not.toExist(),
			expectView(role("button", { name: "Delete Dana Kim's override" })).not.toExist(),
			expectView(text("Times in Europe/Berlin. Yours is UTC.")).toExist(),
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
				(shift) => isoMs(shift.starts_at) >= weekStart && isoMs(shift.ends_at) <= ONCALL_NOW,
			),
		)
		const running = Option.getOrThrow(
			Arr.findFirst(
				shifts.final,
				(shift) => isoMs(shift.starts_at) <= ONCALL_NOW && ONCALL_NOW < isoMs(shift.ends_at),
			),
		)
		const endedName = `${memberName(oncallMembers, ended.user_id)}, ${formatShiftEdge(isoMs(ended.starts_at), BERLIN)} to ${formatShiftEdge(isoMs(ended.ends_at), BERLIN)}`
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("img", { name: endedName })).toExist(),
			expectView(role("button", { name: endedName })).not.toExist(),
		)
		const ignored = pageUpdate(
			model,
			Message.ClickedShift({ startMs: isoMs(ended.starts_at), endMs: isoMs(ended.ends_at) }),
		)
		expect(ignored.model.overrideOpenCount).toBe(model.overrideOpenCount)
		const opened = run(model, [
			Message.ClickedShift({ startMs: isoMs(running.starts_at), endMs: isoMs(running.ends_at) }),
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
})
