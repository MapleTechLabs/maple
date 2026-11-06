import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { OnCallOverrideId } from "@maple/domain/http"
import { zonedDayStart } from "@maple/views/ui/shift-timeline"
import { Option, Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
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
import { CALENDAR_DAYS, init, overrideIssue, update } from "./update"
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
			result: Result.succeed(checkoutSchedule(nowMs)),
		}),
		Message.CompletedFetchOverrides({
			key: entered.model.overrides.key ?? "",
			result: Result.succeed(checkoutOverrides(nowMs)),
		}),
	])
	const fromMs = zonedDayStart(nowMs, BERLIN)
	const toMs = zonedDayStart(nowMs, BERLIN, CALENDAR_DAYS)
	return run(base, [
		Message.CompletedFetchShifts({
			key: base.shifts.key ?? "",
			result: Result.succeed(checkoutShifts(nowMs, fromMs, toMs)),
		}),
	])
}

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

	test("moving a week reads that week's shifts; Today comes back", () => {
		const model = loaded(ONCALL_NOW)
		const next = pageUpdate(model, Message.ClickedNextWeek())
		expect(names(next.commands)).toEqual(["FetchOnCallShifts"])
		expect(next.model.weekOffset).toBe(1)
		expect(pageUpdate(next.model, Message.ClickedThisWeek()).model.weekOffset).toBe(0)
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
		const draft = { userId: memberId(1), startsAt: "2026-11-12T10:00", endsAt: "2026-11-12T09:00" }
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

	test("deleting an override sends one delete, then reads the overrides and shifts again", () => {
		const overrideId = Schema.decodeSync(OnCallOverrideId)(overrideUuid(1))
		const asked = pageUpdate(loaded(ONCALL_NOW), Message.ClickedDeleteOverride({ overrideId }))
		expect(names(asked.commands)).toEqual(["DeleteOnCallOverride"])
		expect(
			names(pageUpdate(asked.model, Message.ClickedDeleteOverride({ overrideId })).commands),
		).toEqual([])
		const done = pageUpdate(
			asked.model,
			Message.CompletedDeleteOverride({ overrideId, result: Result.void }),
		)
		expect(names(done.commands)).toContain("FetchOnCallOverrides")
		expect(names(done.commands)).toContain("FetchOnCallShifts")
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
})
