import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { EscalationChainId, OnCallScheduleId } from "@maple/domain/http"
import type { V2OnCallSchedule } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import * as Menu from "@maple/views/ui/menu"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { chainDestinations, chainUuid } from "../shared/escalation-test-fixtures"
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
import { init, routeChanged, scheduleMenuId, update } from "./update"
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
	schedules: ReadonlyArray<V2OnCallSchedule> | null,
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
			...(schedules === null
				? []
				: [
						Message.CompletedFetchSchedules({
							key: entered.model.schedules.key ?? "",
							readAtMs: ONCALL_NOW,
							result: Result.succeed(schedules),
						}),
					]),
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

	test("a failed refresh keeps the strip, and the clock still reads the schedules again", () => {
		const hour = 3_600_000
		const refreshing = pageUpdate(
			onTab("inbox", ENGINEER, SCHEDULES),
			Message.ReadClock({ nowMs: ONCALL_NOW + 4 * hour }),
		)
		expect(names(refreshing.commands)).toContain("FetchAlertsHubSchedules")
		const failed = pageUpdate(
			refreshing.model,
			Message.CompletedFetchSchedules({
				key: refreshing.model.schedules.key ?? "",
				readAtMs: ONCALL_NOW + 4 * hour,
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
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(role("region", { name: "On call now" })).toExist(),
		)
		// Not on every tick while it keeps failing: the next try waits the five-minute max age.
		expect(
			names(pageUpdate(failed, Message.ReadClock({ nowMs: ONCALL_NOW + 4 * hour + 30_000 })).commands),
		).not.toContain("FetchAlertsHubSchedules")
		expect(
			names(pageUpdate(failed, Message.ReadClock({ nowMs: ONCALL_NOW + 8 * hour })).commands),
		).toContain("FetchAlertsHubSchedules")
	})

	test("an org with schedules but no rules sees who is on call above the empty inbox", () => {
		const entered = init({ _tag: "Alerts", search: { tab: "inbox" } }, context)
		const model = Arr.reduce(
			[
				Message.ReadClock({ nowMs: ONCALL_NOW }),
				Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
				Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
				Message.UpdatedDestinations({ orgId: ORG, rows: [] }),
				Message.UpdatedRules({ orgId: ORG, rows: [] }),
				Message.UpdatedRuleStates({ orgId: ORG, rows: [] }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [] }),
				Message.CompletedFetchSchedules({
					key: entered.model.schedules.key ?? "",
					readAtMs: ONCALL_NOW,
					result: Result.succeed(SCHEDULES),
				}),
			],
			entered.model,
			(current, message) => pageUpdate(current, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("region", { name: "On call now" })).toExist(),
		)
	})

	test("a failed members read is asked again on the next route change", () => {
		const entered = init({ _tag: "Alerts", search: { tab: "inbox" } }, context)
		expect(names(entered.commands)).toContain("FetchAlertsHubMembers")
		const failed = pageUpdate(
			entered.model,
			Message.CompletedFetchMembers({ result: Result.fail("Clerk is down") }),
		).model
		expect(
			names(routeChanged(failed, { _tag: "Alerts", search: { tab: "oncall" } }, context).commands),
		).toContain("FetchAlertsHubMembers")
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

	test("before the schedules load, a chain says it pages the on-call rather than a deleted schedule", () => {
		scene(
			{ update: pageUpdate, view },
			given(onTab("routing", ENGINEER, null)),
			expectView(text(/then the on-call and Dana Kim after 5m/u)).toExist(),
			expectView(text(/a deleted schedule/u)).not.toExist(),
		)
	})

	test("members are read only by the tabs that name people, once", () => {
		const rules = init({ _tag: "Alerts", search: { tab: "rules" } }, context)
		expect(names(rules.commands)).not.toContain("FetchAlertsHubMembers")
		const oncall = routeChanged(rules.model, { _tag: "Alerts", search: { tab: "oncall" } }, context)
		expect(names(oncall.commands)).toContain("FetchAlertsHubMembers")
		const routing = routeChanged(oncall.model, { _tag: "Alerts", search: { tab: "routing" } }, context)
		expect(names(routing.commands)).not.toContain("FetchAlertsHubMembers")
	})

	test("a deleted chain reads the schedules again, whose chain lists named it", () => {
		const model = onTab("routing", ENGINEER, SCHEDULES)
		const chainId = Schema.decodeSync(EscalationChainId)(chainUuid(1))
		const deleted = pageUpdate(
			{ ...model, confirmDeleteChainId: chainId, deletingChainId: chainId },
			Message.CompletedDeleteChain({ chainId, result: Result.void }),
		)
		expect(names(deleted.commands)).toContain("FetchAlertsHubSchedules")
	})
})
