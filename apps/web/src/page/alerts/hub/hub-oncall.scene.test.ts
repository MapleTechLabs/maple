import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { OnCallScheduleId } from "@maple/domain/http"
import type { V2OnCallSchedule } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import * as Menu from "@maple/views/ui/menu"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { chainDestinations } from "../shared/escalation-test-fixtures"
import { SCHEDULE_IN_USE_CODE } from "../shared/oncall-schedules"
import {
	mixedTargetChain,
	ONCALL_NOW,
	oncallMembers,
	populatedSchedules,
	scheduleUuid,
} from "../shared/oncall-test-fixtures"
import { incidentRow, ORG, ruleRow } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, scheduleMenuId, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])
const SCHEDULES = populatedSchedules(ONCALL_NOW)

const onTab = (
	tab: string,
	grants: ReturnType<typeof Policy.grantsOf>,
	schedules: ReadonlyArray<V2OnCallSchedule>,
) => {
	const entered = init({ _tag: "Alerts", search: { tab } }, context)
	expect(names(entered.commands)).toContain("FetchAlertsHubSchedules")
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: ONCALL_NOW }),
			Message.CompletedFetchSession({ orgId: ORG, grants }),
			Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
			Message.UpdatedDestinations({ orgId: ORG, rows: chainDestinations }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(1), ruleRow(2)] }),
			Message.UpdatedRuleStates({ orgId: ORG, rows: [] }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
			Message.CompletedFetchChains({
				key: entered.model.chains.key ?? "",
				result: Result.succeed([mixedTargetChain(chainDestinations[0]?.id ?? "")]),
			}),
			Message.CompletedFetchSchedules({
				key: entered.model.schedules.key ?? "",
				readAtMs: ONCALL_NOW,
				result: Result.succeed(schedules),
			}),
		],
		entered.model,
		(model, message) => pageUpdate(model, message).model,
	)
}

describe("alerts hub, on-call schedules", () => {
	test("an org without schedules learns what one is and can create the first", () => {
		scene(
			{ update: pageUpdate, view },
			given(onTab("oncall", ENGINEER, [])),
			expectView(text("No on-call schedules")).toExist(),
			expectView(text(/people take turns in layers/u)).toExist(),
			expectView(role("link", { name: "Create schedule" })).toExist(),
		)
	})

	test("each schedule names its zone, who is on call until when, and the next handoff", () => {
		scene(
			{ update: pageUpdate, view },
			given(onTab("oncall", ENGINEER, SCHEDULES)),
			expectView(text("Checkout primary")).toExist(),
			expectView(text("Europe/Berlin · 3 layers")).toExist(),
			expectView(text("Sofia Alvarez")).toExist(),
			expectView(text(/^until Tue,? 10 Nov,? 17:00$/u)).toExist(),
			expectView(text("Hands off in 5h 30m")).toExist(),
			expectView(text("Nobody on call")).toExist(),
			expectView(role("link", { name: "New schedule" })).toExist(),
			expectView(role("button", { name: "Actions for Checkout primary" })).toExist(),
		)
	})

	test("a member sees the schedules but cannot create, edit or delete one", () => {
		scene(
			{ update: pageUpdate, view },
			given(onTab("oncall", MEMBER, SCHEDULES)),
			expectView(text("Checkout primary")).toExist(),
			expectView(role("link", { name: "New schedule" })).not.toExist(),
			expectView(role("button", { name: "Actions for Checkout primary" })).not.toExist(),
		)
	})

	test("the inbox opens with who is on call on each schedule", () => {
		scene(
			{ update: pageUpdate, view },
			given(onTab("inbox", MEMBER, SCHEDULES)),
			expectView(role("region", { name: "On call now" })).toExist(),
			expectView(text("Sofia Alvarez")).toExist(),
			expectView(text("Priya Raman")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(onTab("inbox", MEMBER, [])),
			expectView(role("region", { name: "On call now" })).not.toExist(),
		)
	})

	test("the clock reads the schedules again once a shown shift has handed off, not before", () => {
		const model = onTab("oncall", ENGINEER, SCHEDULES)
		expect(
			names(pageUpdate(model, Message.ReadClock({ nowMs: ONCALL_NOW + 60_000 })).commands),
		).not.toContain("FetchAlertsHubSchedules")
		expect(
			names(pageUpdate(model, Message.ReadClock({ nowMs: ONCALL_NOW + 4 * 3_600_000 })).commands),
		).toContain("FetchAlertsHubSchedules")
	})

	test("a chain's summary names the people and schedules it pages", () => {
		scene(
			{ update: pageUpdate, view },
			given(onTab("routing", ENGINEER, SCHEDULES)),
			expectView(
				text(
					"Slack #alerts-api, then whoever is on call on Checkout primary and Dana Kim after 5m, then Ben Brook after 15m; repeats once",
				),
			).toExist(),
		)
	})

	test("a refused delete names the chains that still page the schedule", () => {
		const model = onTab("oncall", ENGINEER, SCHEDULES)
		const scheduleId = Schema.decodeSync(OnCallScheduleId)(scheduleUuid(1))
		const asked = pageUpdate(
			pageUpdate(
				model,
				Message.GotRowMenuMessage({
					menuId: scheduleMenuId(scheduleId),
					message: Menu.Message.ClickedItem({ index: 1, item: { kind: "Item", value: "delete" } }),
				}),
			).model,
			Message.ClickedConfirmDeleteSchedule(),
		)
		expect(names(asked.commands)).toEqual(["DeleteOnCallSchedule"])
		const refused = pageUpdate(
			asked.model,
			Message.CompletedDeleteSchedule({
				scheduleId,
				result: Result.fail({
					_tag: "@maple/http/errors/OnCallScheduleInUseError",
					type: "conflict_error",
					code: SCHEDULE_IN_USE_CODE,
					title: "Schedule is in use",
					message: "An escalation chain pages this schedule.",
					retryable: false,
					recovery: "fix_request",
				}),
			}),
		)
		expect(refused.model.deleteScheduleError).toBe(
			"Still paged by Checkout on-call. Remove it from those chains first.",
		)
	})
})
