import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { pagedEvents } from "../shared/oncall-test-fixtures"
import { incidentRow, INCIDENT_ID, NOW, ORG, ruleRow } from "../shared/test-rows"
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
const route = { _tag: "AlertIncident" as const, incidentId: INCIDENT_ID, search: {} }
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

describe("alert incident, pages to people", () => {
	test("the incident reads its events with the escalation, and again when it is acknowledged", () => {
		const entered = run(init(route, context).model, [Message.ReadClock({ nowMs: NOW })])
		const first = pageUpdate(entered, Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }))
		expect(names(first.commands)).toContain("FetchAlertIncidentEvents")
		const same = pageUpdate(first.model, Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }))
		expect(names(same.commands)).not.toContain("FetchAlertIncidentEvents")
		const acked = pageUpdate(
			first.model,
			Message.UpdatedIncidents({
				orgId: ORG,
				rows: [incidentRow({ acknowledged_at: "2026-10-01T11:58:00.000Z" })],
			}),
		)
		expect(names(acked.commands)).toContain("FetchAlertIncidentEvents")
	})

	test("the timeline says who was paged on which channel, and why a page failed", () => {
		const row = incidentRow()
		const synced = run(init(route, context).model, [
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [row] }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }),
		])
		const model = run(synced, [
			Message.CompletedFetchEvents({
				key: synced.events.key ?? "",
				result: Result.succeed(pagedEvents(INCIDENT_ID, Date.parse(row.first_triggered_at))),
			}),
			Message.CompletedFetchDeliveries({
				key: synced.deliveries.key ?? "",
				result: Result.succeed([]),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("Paged Ben Brook by Slack DM")).toExist(),
			expectView(text("Paged Ben Brook by email")).toExist(),
			expectView(text("Couldn't page Dana Kim by Discord DM")).toExist(),
			expectView(text("Dana has not linked a Discord account")).toExist(),
			expectView(text("Paging Dana Kim by email")).toExist(),
		)
	})
})
