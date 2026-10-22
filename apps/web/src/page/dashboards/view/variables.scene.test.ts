import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as Combobox from "../../../ui/combobox"
import * as Field from "../../../ui/field"
import { PageOutMessage, type PageContext } from "../../contract"
import * as Manager from "../kit/variables-manager/model"
import { SaveVariables } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const manager = (message: Manager.Message) => Message.GotVariablesManagerMessage({ message })

const document = (variables: ReadonlyArray<unknown>) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash_vars",
		name: "Vars",
		timeRange: { type: "relative", value: "6h" },
		widgets: [],
		variables,
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})

const ENV = { name: "env", type: "custom", options: [{ value: "production" }, { value: "staging" }] }
const ROUTE = { dashboardId: "dash_vars", search: { mode: "edit" as const } }

const ready = (variables: ReadonlyArray<unknown>): Model =>
	[
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document(variables)) }),
	].reduce((model, message) => pageUpdate(model, message).model, init(ROUTE, context).model)

describe("dashboard variables", () => {
	test("a picked value rides var-<name> in the URL", () => {
		const combo = (message: Combobox.Message) => Message.GotVariableComboMessage({ name: "env", message })
		const picked = pageUpdate(ready([ENV]), combo(Combobox.Message.ClickedItem({ value: "staging" })))
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_vars?mode=edit&var-env=staging",
				isReplace: true,
			}),
		)
	})

	test("the manager on an empty board starts one blank draft and will not save it unnamed", () => {
		const opened = pageUpdate(ready([]), Message.ClickedManageVariables()).model
		expect(opened.variablesManager.startedEmpty).toBe(true)
		expect(opened.variablesManager.editingIndex).toBe(0)
		expect(names(pageUpdate(opened, manager(Manager.Message.SubmittedForm())).commands)).not.toContain(
			SaveVariables.name,
		)
	})

	test("a named draft saves the board's variables in one write", () => {
		const opened = pageUpdate(ready([]), Message.ClickedManageVariables()).model
		const typed = pageUpdate(
			opened,
			manager(
				Manager.Message.GotFieldMessage({
					field: "name",
					message: Field.Message.ChangedValue({ value: "service" }),
				}),
			),
		).model
		expect(typed.variablesManager.drafts[0]?.name).toBe("service")
		const saved = pageUpdate(typed, manager(Manager.Message.SubmittedForm()))
		expect(names(saved.commands)).toContain(SaveVariables.name)
		expect(saved.model.variablesManager.dialog.isOpen).toBe(false)
	})
})
