import { OrgId } from "@maple/domain"
import { AlertDestinationId, AlertRuleId } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { click, expect as expectView, expectOutMessage, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import * as Menu from "../../../ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import { destinationRow, incidentRow, NOW, ORG, ruleId, ruleRow, stateRow } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, ruleMenuId, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const RULE_2 = Schema.decodeSync(AlertRuleId)(ruleId(2))
const DESTINATION = Schema.decodeSync(AlertDestinationId)(destinationRow().id)

const entered = (search: Model["search"] = {}) => init({ _tag: "Alerts", search }, context)

/** The four shapes and the clock have answered: rule 2 is firing, rule 4 is off. */
const loaded = (search: Model["search"] = {}): Model =>
	[
		Message.ReadClock({ nowMs: NOW }),
		Message.UpdatedRules({
			orgId: ORG,
			rows: [ruleRow(1), ruleRow(2, { name: "Payment p95 latency" }), ruleRow(4, { enabled: false })],
		}),
		Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(1), stateRow(2, { last_status: "breached", last_value: 1840 })] }),
		Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow({ rule_name: "Payment p95 latency" })] }),
		Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
		Message.CompletedFetchSession({ orgId: ORG, isAdmin: true }),
	].reduce((model, message) => pageUpdate(model, message).model, entered(search).model)

describe("alerts hub", () => {
	test("entry reads the clock, the session and the deliveries list; Routing adds its own read", () => {
		expect(names(entered().commands)).toEqual(
			expect.arrayContaining(["ReadAlertsHubClock", "FetchAlertsHubSession", "FetchAlertsHubDeliveries"]),
		)
		expect(names(entered().commands)).not.toContain("FetchAlertsRoutingDeliveries")
		expect(names(entered({ tab: "routing" }).commands)).toContain("FetchAlertsRoutingDeliveries")
	})

	test("live rows read for another org are dropped", () => {
		const model = entered().model
		const other = pageUpdate(model, Message.UpdatedRules({ orgId: "org_other", rows: [ruleRow(1)] }))
		expect(other.model.rules).toBeNull()
	})

	test("the inbox leads with what is firing and links the incident", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(text("1 firing")).toExist(),
			expectView(role("link", { name: "P95 latency 1.84s on all" })).toHaveAttr(
				"href",
				"/alerts/incidents/0199a003-0000-7000-8000-000000000001",
			),
		)
	})

	test("a live sync that stops before its first answer shows the failure with a retry, not a skeleton", () => {
		const clocked = pageUpdate(entered().model, Message.ReadClock({ nowMs: NOW })).model
		const failed = pageUpdate(clocked, Message.FailedLoadAlerts({ orgId: ORG })).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Failed to load alerts")).toExist(),
			click(role("button", { name: "Try again" })),
			expectOutMessage(PageOutMessage.RequestedReconnectOrgCollections()),
		)
	})

	test("a late sync failure does not hide alerts that already arrived", () => {
		const late = pageUpdate(loaded(), Message.FailedLoadAlerts({ orgId: ORG })).model
		expect(late.isLoadFailed).toBe(false)
	})

	test("an org with no rules gets the two-step empty state", () => {
		const empty = pageUpdate(loaded(), Message.UpdatedRules({ orgId: ORG, rows: [] })).model
		const noDestinations = pageUpdate(empty, Message.UpdatedDestinations({ orgId: ORG, rows: [] })).model
		scene({ update: pageUpdate, view }, given(noDestinations), expectView(text("Two steps to your first alert")).toExist())
	})

	test("a status chip writes its bucket to the URL, and pressing it again clears it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "rules" })),
			click(role("button", { name: /^Firing/ })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/alerts?tab=rules&status=firing",
					isReplace: false,
				}),
			),
		)
		const cleared = pageUpdate(
			loaded({ tab: "rules", status: "firing" }),
			Message.ClickedStatusFilter({ bucket: "firing" }),
		)
		expect(cleared.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/alerts?tab=rules", isReplace: false }),
		)
	})

	test("disabling a rule sends one PATCH at a time and a failed write says so", () => {
		const toggling = pageUpdate(loaded({ tab: "rules" }), Message.ClickedToggleRule({ ruleId: RULE_2, isEnabled: false }))
		expect(names(toggling.commands)).toEqual(["ToggleAlertRule"])
		const again = pageUpdate(toggling.model, Message.ClickedToggleRule({ ruleId: RULE_2, isEnabled: false }))
		expect(again.commands ?? []).toHaveLength(0)
		const failed = pageUpdate(
			toggling.model,
			Message.CompletedToggleRule({
				ruleId: RULE_2,
				result: Result.fail(toLoadFailure(new Error("boom"))),
			}),
		)
		scene({ update: pageUpdate, view }, given(failed.model), expectView(text("Failed to update the rule. Try again.")).toExist())
	})

	test("a destination test toasts the outcome and revalidates both delivery reads", () => {
		const routing = loaded({ tab: "routing" })
		const testing = pageUpdate(routing, Message.ClickedTestDestination({ destinationId: DESTINATION }))
		expect(names(testing.commands)).toEqual(["TestAlertDestination"])
		const done = pageUpdate(
			testing.model,
			Message.CompletedTestDestination({
				destinationId: DESTINATION,
				result: Result.succeed({ message: "Test notification sent", success: true }),
			}),
		)
		expect(done.model.testingDestinationIds).toEqual([])
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Test notification sent", description: "" }),
		)
	})

	test("a chat destination's routing row names its connector, not a generic Chat", () => {
		const chat = destinationRow({
			type: "chat",
			name: "Eng alerts",
			config_json: { summary: "#alerts", channelLabel: null, chatConnector: "slack" },
		})
		const model = pageUpdate(loaded({ tab: "routing" }), Message.UpdatedDestinations({ orgId: ORG, rows: [chat] })).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Slack")).toExist(),
			expectView(text("Chat")).not.toExist(),
		)
	})

	test("a rule listed under several tags has a menu per tag, and each acts on that rule", () => {
		const tagged = pageUpdate(
			loaded({ tab: "rules" }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2, { tags_json: ["team:payments", "tier:p1"] })] }),
		).model
		const menus = ["team:payments", "tier:p1"].map((tag) => ruleMenuId(RULE_2, tag))
		expect(new Set(menus).size).toBe(2)
		const opened = pageUpdate(tagged, Message.GotRowMenuMessage({
			menuId: menus[1] ?? "",
			message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value: "open" } }),
		}))
		expect(opened.outMessage?._tag).toBe("RequestedNavigation")
	})

	test("delete asks first, then sends the DELETE and closes on success", () => {
		const routing = loaded({ tab: "routing" })
		const asked = pageUpdate(routing, Message.GotRowMenuMessage({
			menuId: `destination:${DESTINATION}`,
			message: Menu.Message.ClickedItem({ index: 2, item: { kind: "Item", value: "delete" } }),
		}))
		expect(asked.model.confirmDeleteId).toBe(DESTINATION)
		expect(asked.model.deleteDialog.isOpen).toBe(true)
		const deleting = pageUpdate(asked.model, Message.ClickedConfirmDeleteDestination())
		expect(names(deleting.commands)).toEqual(["DeleteAlertDestination"])
		const done = pageUpdate(
			deleting.model,
			Message.CompletedDeleteDestination({ destinationId: DESTINATION, result: Result.succeed(undefined) }),
		)
		expect(done.model.deleteDialog.isOpen).toBe(false)
		expect(done.outMessage).toEqual(PageOutMessage.RequestedToast({ type: "success", title: "Destination deleted", description: "" }))
	})
})
