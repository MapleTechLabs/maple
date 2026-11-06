import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import * as Combobox from "@maple/views/ui/combobox"
import * as Field from "@maple/views/ui/field"
import { PageOutMessage, type PageContext } from "../../contract"
import * as Manager from "../kit/variables-manager/model"
import { dataStateOf } from "../kit/data-state"
import { FetchWidget, SaveVariables } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
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
	Arr.reduce(
		[
			Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document(variables)) }),
		],
		init(ROUTE, context).model,
		(model, message) => pageUpdate(model, message).model,
	)

const SERVICE = { name: "service", type: "query", source: { kind: "facet", facet: "service" } }

/** A tile filtered by `$service`, revealed on a board whose `service` options are being fetched. */
const throughputBoard = () => {
	const board = Schema.decodeSync(DashboardDocument)({
		...Schema.encodeSync(DashboardDocument)(document([SERVICE])),
		widgets: [
			{
				id: "throughput",
				visualization: "chart",
				dataSource: {
					kind: "query",
					resultShape: "timeseries",
					queries: [
						{
							id: "q",
							name: "Throughput",
							dataSource: "traces",
							aggregation: "count",
							whereClause: 'service.name = "$service"',
							addOns: {
								groupBy: false,
								having: false,
								orderBy: false,
								limit: false,
								legend: false,
							},
							groupBy: [],
						},
					],
				},
				display: { title: "Throughput", chartId: "query-builder-area" },
				layout: { x: 0, y: 0, w: 6, h: 6 },
			},
		],
	})
	const entered = pageUpdate(
		ready([SERVICE]),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(board) }),
	).model
	return { board, revealed: pageUpdate(entered, Message.RevealedWidget({ widgetId: "throughput" })) }
}

describe("dashboard variables", () => {
	test("a failed options fetch makes its tiles say the variable is unavailable, not load forever", () => {
		const { board, revealed } = throughputBoard()
		expect(names(revealed.commands)).not.toContain(FetchWidget.name)
		const key = revealed.model.variableOptions.service?.key ?? ""
		expect(key).not.toBe("")
		const failed = pageUpdate(
			revealed.model,
			Message.CompletedFetchVariableOptions({
				name: "service",
				key,
				result: Result.fail({ title: null, message: "Warehouse timed out", kind: "runtime" }),
			}),
		)
		// The variable no longer resolves to "" and runs the tile with an empty filter.
		expect(names(failed.commands)).not.toContain(FetchWidget.name)
		const widget = board.widgets[0]
		const state =
			widget === undefined
				? null
				: dataStateOf(failed.model.requests, widget, failed.model.widgets.throughput?.gate ?? null)
		expect(state).toEqual({
			_tag: "Error",
			title: "Variable $service unavailable",
			message: "Warehouse timed out",
			kind: null,
		})
	})

	test("a tile reading a variable whose options are still loading waits for them", () => {
		const { revealed } = throughputBoard()
		expect(names(revealed.commands)).not.toContain(FetchWidget.name)
		expect(revealed.model.widgets.throughput?.gate?._tag).toBe("WaitingOnVariables")
	})

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
