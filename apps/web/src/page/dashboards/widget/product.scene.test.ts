import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { dataSourceEndpoint } from "@maple/widgets/dashboard"
import { Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { SaveWidget } from "./command"
import { buildDisplay, validationErrorOf } from "./lowering"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { ProductEdit } from "./product-edit"
import { setDataSource } from "./edits"
import { targetIndex } from "./list-column-drag"
import * as Select from "../../../ui/select"
import { init } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_platform",
	name: "Platform overview",
	timeRange: { type: "relative", value: "6h" },
	widgets: [
		{
			id: "throughput",
			visualization: "chart",
			dataSource: {
				kind: "query",
				resultShape: "timeseries",
				queries: [
					{ id: "q1", name: "A", dataSource: "traces", aggregation: "count", whereClause: "" },
				],
			},
			display: { title: "Throughput", chartId: "query-builder-line" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

type Step = Readonly<{ model: Model; commands: ReadonlyArray<{ readonly name: string }> }>

const run = (step: Step, ...messages: ReadonlyArray<Message>): Step =>
	messages.reduce<Step>((current, message) => {
		const next = update(current.model, message, context)
		return { model: next.model, commands: [...current.commands, ...(next.commands ?? [])] }
	}, step)

const opened = (): Step =>
	run(
		{
			model: init({ dashboardId: "dash_platform", widgetId: "throughput", search: {} }, context).model,
			commands: [],
		},
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	)

const edit = (change: ProductEdit) => Message.ChangedProduct({ edit: change })
const names = (step: Step) => step.commands.map(({ name }) => name)

describe("list, funnel and paths panels", () => {
	test("a chart switched to a list on logs writes a list_logs widget with its columns", () => {
		const step = run(
			opened(),
			Message.ClickedPanelType({ panel: "list" }),
			edit(ProductEdit.SetListSource({ source: "logs" })),
			edit(ProductEdit.ChangedListWhere({ value: 'service.name = "api"' })),
			edit(ProductEdit.AddedListColumn()),
			edit(ProductEdit.ChangedListColumnText({ index: 4, field: "header", value: "Trace" })),
		)
		const state = step.model.state
		expect(state?.listColumns.map((column) => column.header)).toEqual([
			"Time",
			"Severity",
			"Service",
			"Message",
			"Trace",
		])
		const applied = run(step, Message.ClickedApply())
		expect(names(applied)).toContain(SaveWidget.name)
		expect(state === null ? null : buildDisplay(document.widgets[0], state).listDataSource).toBe("logs")
	})

	test("a column dragged past two centres lands two slots down", () => {
		const list = run(
			opened(),
			Message.ClickedPanelType({ panel: "list" }),
			edit(ProductEdit.SetListSource({ source: "logs" })),
		)
		// Rows 40 px apart: the first row's centre dragged 85 px down passes the next two.
		const to = targetIndex([20, 60, 100, 140], 0, 20 + 85)
		const dragged = run(list, edit(ProductEdit.MovedListColumn({ index: 0, delta: to })))
		expect(dragged.model.state?.listColumns.map((column) => column.header)).toEqual([
			"Severity",
			"Service",
			"Time",
			"Message",
		])
	})

	test("the paths panel blocks Apply until the anchor names an event", () => {
		const paths = run(opened(), Message.ClickedPanelType({ panel: "paths" }))
		expect(paths.model.state === null ? null : validationErrorOf(paths.model.state)).toBe(
			"The anchor needs an event name or page path",
		)
		expect(names(run(paths, Message.ClickedApply()))).not.toContain(SaveWidget.name)
		const anchored = run(
			paths,
			edit(
				ProductEdit.ChangedStepText({
					scope: "paths",
					index: 0,
					field: "eventName",
					value: "checkout_started",
				}),
			),
			edit(ProductEdit.SetPathsDirection({ direction: "before" })),
		)
		expect(anchored.model.state?.paths.anchor).toEqual({ kind: "event", eventName: "checkout_started" })
		expect(names(run(anchored, Message.ClickedApply()))).toContain(SaveWidget.name)
	})

	test("the step editor's source select brings the query set back on that source", () => {
		const onFunnel = run(opened(), Message.ClickedPanelType({ panel: "funnel" }))
		const first = onFunnel.model.state?.queries[0]?.id ?? ""
		const onEvents = {
			...onFunnel,
			model: {
				...onFunnel.model,
				state:
					onFunnel.model.state === null
						? null
						: setDataSource(onFunnel.model.state, first, "product_events"),
			},
		}
		expect(onEvents.model.state?.funnel.source).toBe("product_events")
		expect(onEvents.model.state?.funnel.steps).toEqual([{ kind: "event", eventName: "" }])
		const back = run(
			onEvents,
			Message.GotSelectMessage({
				id: "funnel-source",
				message: Select.Message.SelectedItem({ index: 1, value: "logs" }),
			}),
		)
		expect(back.model.state?.funnel.source).toBe("query_set")
		expect(back.model.state?.queries[0]?.dataSource).toBe("logs")
	})

	test("a session step moved below step 1 becomes an event step", () => {
		const step = run(
			opened(),
			Message.ClickedPanelType({ panel: "funnel" }),
			edit(ProductEdit.AddedStep()),
			edit(ProductEdit.AddedStep()),
			edit(ProductEdit.SetStepKind({ scope: "funnel", index: 0, kind: "session" })),
			edit(ProductEdit.MovedStep({ index: 0, delta: 1 })),
		)
		expect(step.model.state?.funnel.steps.map((candidate) => candidate.kind)).toEqual(["event", "event"])
	})

	test("the funnel's view writes only its rendering flags on a query-set funnel", () => {
		const step = run(
			opened(),
			Message.ClickedPanelType({ panel: "funnel" }),
			edit(ProductEdit.SetFunnelVariant({ variant: "dropoff" })),
		)
		const state = step.model.state
		expect(state === null ? null : buildDisplay(document.widgets[0], state).funnel).toEqual({
			variant: "dropoff",
		})
		expect(state === null ? null : dataSourceEndpoint(document.widgets[0].dataSource)).not.toBe(
			"product_events_funnel",
		)
	})
})
