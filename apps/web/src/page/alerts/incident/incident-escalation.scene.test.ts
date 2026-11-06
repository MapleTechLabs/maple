import { OrgId } from "@maple/domain"
import type { V2AlertIncidentEscalation } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import type { PageContext } from "../../contract"
import { runOf } from "../shared/escalation-test-fixtures"
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
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const route = { _tag: "AlertIncident" as const, incidentId: INCIDENT_ID, search: {} }
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const synced = (row = incidentRow()) =>
	run(init(route, context).model, [
		Message.ReadClock({ nowMs: NOW }),
		Message.UpdatedIncidents({ orgId: ORG, rows: [row] }),
		Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }),
	])

const withRun = (model: Model, run: V2AlertIncidentEscalation | null) =>
	pageUpdate(
		model,
		Message.CompletedFetchEscalation({ key: model.escalation.key ?? "", result: Result.succeed(run) }),
	).model

describe("alert incident, escalation", () => {
	test("the incident reads its escalation once, and again when it is acknowledged", () => {
		const entered = run(init(route, context).model, [Message.ReadClock({ nowMs: NOW })])
		const first = pageUpdate(entered, Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }))
		expect(names(first.commands)).toContain("FetchAlertIncidentEscalation")
		const same = pageUpdate(first.model, Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }))
		expect(names(same.commands)).not.toContain("FetchAlertIncidentEscalation")
		const acked = pageUpdate(
			first.model,
			Message.UpdatedIncidents({
				orgId: ORG,
				rows: [incidentRow({ acknowledged_at: "2026-10-01T11:58:00.000Z" })],
			}),
		)
		expect(names(acked.commands)).toContain("FetchAlertIncidentEscalation")
	})

	test("a running chain shows its step and when it pages next", () => {
		scene(
			{ update: pageUpdate, view },
			given(withRun(synced(), runOf("active", { nextStepAt: "2026-10-01T12:10:00.000Z" }))),
			themeResolved(),
			expectView(role("heading", { name: "Escalation" })).toExist(),
			expectView(text("Escalating")).toExist(),
			expectView(text("Checkout on-call")).toExist(),
			expectView(text(/^Step 2 of 3, pass 1 of 3, next page at /u)).toExist(),
			expectView(text("1 step paged so far")).toExist(),
		)
	})

	test("an acknowledged incident pauses the chain", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				withRun(
					synced(incidentRow({ acknowledged_at: "2026-10-01T11:58:00.000Z" })),
					runOf("active"),
				),
			),
			themeResolved(),
			expectView(text("Paused: acknowledged")).toExist(),
			expectView(text(/Resumes if the incident is unacknowledged/u)).toExist(),
		)
	})

	test("a finished chain says why, and an incident without one shows no section", () => {
		scene(
			{ update: pageUpdate, view },
			given(withRun(synced(), runOf("exhausted", { step: 3, stepsSent: 9 }))),
			themeResolved(),
			expectView(text("Finished")).toExist(),
			expectView(text("Every step was sent")).toExist(),
			expectView(text("9 steps paged")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withRun(synced(), null)),
			themeResolved(),
			expectView(role("heading", { name: "Escalation" })).not.toExist(),
		)
	})
})
