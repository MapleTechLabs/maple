import { defaultWidgetLayout } from "@maple/domain/http"
import { MetricsQueryDraftSchema } from "@maple/query-model"
import { makeQueryDataSource } from "@maple/widgets/dashboard"
import { Clock, Effect, Option, Random, Result, Schema, Stream } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { countLabel } from "@maple/ui/lib/format"
import { button } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { errorState } from "../../../ui/error-state"
import { input } from "../../../ui/input"
import { defineMessageUnion } from "foldkit/message"
import { rowToDocument } from "../../../data/collections/dashboards"
import { trackProduct } from "../../../data/analytics"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { liveQueryStream } from "../../../data/live-query"
import { orgLive } from "../../../data/collections/org-collections"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import { generateWidgetId, withAddedWidget } from "../../dashboards/kit/layout"
import { createPayload } from "../../dashboards/kit/portable"
import { awaitTxid, mutateDashboard, readDocument } from "../../dashboards/kit/store"

// The add-to-dashboard dialog: the
// explorer's query as a chart widget on an existing dashboard, or on a new one created with it.

const DashboardChoice = Schema.Struct({ id: Schema.String, name: Schema.String, widgetCount: Schema.Number })
type DashboardChoice = typeof DashboardChoice.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	/** `useDashboardStore().dashboards`, in the collection's order. */
	dashboards: Schema.Array(DashboardChoice),
	newName: Schema.String,
	isCreating: Schema.Boolean,
	/** The dashboard a widget add is in flight for: one add, and one navigation, per pick. */
	addingTo: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.Struct({ title: Schema.String, failure: LoadFailure })),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	dialog: Dialog.init("metric-add-to-dashboard", "dialog"),
	dashboards: [],
	newName: "",
	isCreating: false,
	addingTo: null,
	error: null,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	UpdatedDashboards: { orgId: Schema.String, dashboards: Schema.Array(DashboardChoice) },
	ChangedNewName: { value: Schema.String },
	ClickedDashboard: { dashboardId: Schema.String },
	ClickedCreate: {},
	CompletedAddWidget: { dashboardId: Schema.String, result: Schema.Result(Schema.Void, LoadFailure) },
	CompletedCreateDashboard: { result: Schema.Result(Schema.String, LoadFailure) },
})
export type Message = typeof Message.Type

/** Where the page goes once the widget landed: the dashboard. */
export const OutMessage = defineMessageUnion({ OpenedDashboard: { dashboardId: Schema.String } })
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

/** `widgetDisplay` and `buildWidgetDataSource`: a fresh query id, never the explorer's own. */
const widgetOf = (draft: typeof MetricsQueryDraftSchema.Type, queryId: string) => ({
	visualization: "chart" as const,
	dataSource: makeQueryDataSource({ resultShape: "timeseries", queries: [{ ...draft, id: queryId }] }),
	display: { title: draft.metricName, chartId: "query-builder-area" },
})

export const AddWidget = Command.define("AddMetricWidgetToDashboard", {
	args: { orgId: Schema.String, dashboardId: Schema.String, draft: MetricsQueryDraftSchema },
	messages: [Message.CompletedAddWidget],
	execute: ({ orgId, dashboardId, draft }) =>
		Effect.gen(function* () {
			const id = generateWidgetId(yield* Clock.currentTimeMillis, yield* Random.next)
			const widget = widgetOf(draft, crypto.randomUUID())
			// `addWidget` throws when the board is not readable; the write itself is not awaited:
			// it navigates on the optimistic update and lets the store report a failed persist.
			yield* readDocument(orgId, dashboardId)
			yield* Effect.forkDetach(
				mutateDashboard(orgId, dashboardId, (document, nowIso) =>
					withAddedWidget(
						document,
						{ id, ...widget, layout: defaultWidgetLayout("chart") },
						nowIso,
					),
				),
			)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedAddWidget({ dashboardId, result })),
		),
})

/** `importDashboard` with the widget in it: one create, so a not-yet-synced board cannot drop it. */
export const CreateDashboard = Command.define("CreateDashboardWithMetricWidget", {
	args: { orgId: Schema.String, name: Schema.String, draft: MetricsQueryDraftSchema },
	messages: [Message.CompletedCreateDashboard],
	execute: ({ orgId, name, draft }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const widget = { id: crypto.randomUUID(), ...widgetOf(draft, crypto.randomUUID()) }
			const created = yield* client.dashboards.create({
				payload: createPayload({
					name,
					timeRange: { type: "relative", value: "12h" },
					widgets: [{ ...widget, layout: { x: 0, y: 0, ...defaultWidgetLayout("chart") } }],
				}),
			})
			// `importDashboard`'s `dashboard_created`, with the one widget.
			yield* trackProduct("dashboard_created", { widgets: 1 })
			yield* awaitTxid(orgId, created.txid)
			return created.id
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedCreateDashboard({ result })),
		),
})

/** The org's dashboards, as the dialog lists them. */
export const dashboardChoices = (orgId: string): Stream.Stream<Message, never, Resources> =>
	orgLive(orgId, ({ dashboards: collection }) =>
		liveQueryStream(
			(q) => q.from({ d: collection }).orderBy(({ d }) => d.updated_at, "desc"),
			(rows) =>
				Message.UpdatedDashboards({
					orgId,
					dashboards: rows.flatMap((row) =>
						Option.toArray(
							Option.map(rowToDocument(row), (document) => ({
								id: document.id,
								name: document.name,
								widgetCount: document.widgets.length,
							})),
						),
					),
				}),
		),
	)

// UPDATE

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

export const open = (model: Model): Return => liftDialog(model, Dialog.open(model.dialog))

type Context = Readonly<{ orgId: string; draft: typeof MetricsQueryDraftSchema.Type | null }>

export const update = (model: Model, message: Message, context: Context): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) => liftDialog(model, Dialog.update(model.dialog, child)),
		UpdatedDashboards: ({ orgId, dashboards }) =>
			orgId === context.orgId ? { model: { ...model, dashboards } } : { model },
		ChangedNewName: ({ value }) => ({ model: { ...model, newName: value } }),
		ClickedDashboard: ({ dashboardId }) =>
			context.draft === null || model.addingTo !== null || model.isCreating
				? { model }
				: {
						model: { ...model, addingTo: dashboardId },
						commands: [AddWidget({ orgId: context.orgId, dashboardId, draft: context.draft })],
					},
		// `handleCreate`: a blank name or a create in flight does nothing.
		ClickedCreate: () => {
			const name = model.newName.trim()
			return name === "" || model.isCreating || model.addingTo !== null || context.draft === null
				? { model }
				: {
						model: { ...model, isCreating: true, error: null },
						commands: [CreateDashboard({ orgId: context.orgId, name, draft: context.draft })],
					}
		},
		CompletedAddWidget: ({ dashboardId, result }) =>
			dashboardId !== model.addingTo
				? { model }
				: Result.match(result, {
						onSuccess: () => closedTo({ ...model, addingTo: null }, dashboardId),
						onFailure: (failure) => ({
							model: {
								...model,
								addingTo: null,
								error: { title: "Failed to add widget", failure },
							},
						}),
					}),
		CompletedCreateDashboard: ({ result }) =>
			Result.match(result, {
				onSuccess: (dashboardId) => closedTo({ ...model, isCreating: false }, dashboardId),
				onFailure: (failure) => ({
					model: {
						...model,
						isCreating: false,
						error: { title: "Failed to create dashboard", failure },
					},
				}),
			}),
	})

/** `onOpenChange(false)` then `navigate({ to: "/dashboards/$dashboardId" })`. */
const closedTo = (model: Model, dashboardId: string): Return => ({
	...liftDialog(model, Dialog.close(model.dialog)),
	outMessage: OutMessage.OpenedDashboard({ dashboardId }),
})

// VIEW

type H = HtmlBuilder<Message>

const choiceRow = (h: H, dashboard: DashboardChoice): Html =>
	h.button(
		[
			h.Key(dashboard.id),
			h.Type("button"),
			h.OnClick(Message.ClickedDashboard({ dashboardId: dashboard.id })),
			h.Class(
				"flex w-full items-center justify-between gap-2 rounded-sm border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
			),
		],
		[
			h.span([h.Class("truncate")], [dashboard.name]),
			h.span(
				[h.Class("shrink-0 text-xs text-muted-foreground")],
				[countLabel(dashboard.widgetCount, "widget")],
			),
		],
	)

const body = (h: H, model: Model): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			...(model.dashboards.length === 0
				? []
				: [
						h.div(
							[h.Class("max-h-64 space-y-1 overflow-y-auto")],
							model.dashboards.map((d) => choiceRow(h, d)),
						),
					]),
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					input(h, {
						id: "metric-add-to-dashboard-name",
						className: "h-8 flex-1 text-sm",
						attributes: [
							h.Value(model.newName),
							h.Placeholder("New dashboard name…"),
							h.OnInput((value) => Message.ChangedNewName({ value })),
							h.OnKeyDownPreventDefault((key) =>
								key === "Enter" ? Option.some(Message.ClickedCreate()) : Option.none(),
							),
						],
					}),
					button(
						h,
						{
							size: "sm",
							isDisabled: model.newName.trim() === "",
							isLoading: model.isCreating,
							attributes: [h.OnClick(Message.ClickedCreate())],
						},
						["Create & add"],
					),
				],
			),
			...(model.error === null
				? []
				: [
						errorState(h, {
							failure: model.error.failure,
							title: model.error.title,
							variant: "inline",
							className: "py-0",
						}),
					]),
		],
	)

export const view = Submodel.defineView<Model, Message, Readonly<{ metricName: string }>>(
	(model, inputs, h) =>
		h.submodel({
			slotId: "metric-add-to-dashboard",
			model: model.dialog,
			view: DialogView.view,
			toParentMessage: (message) => Message.GotDialogMessage({ message }),
			viewInputs: {
				hasTrigger: false,
				hasDescription: true,
				toView: ({ portal }) => portal,
				toContent: () => [
					DialogView.dialogHeader(h, "dialog", [
						DialogView.dialogTitle(h, "dialog", model.dialog.id, "Add to dashboard"),
						DialogView.dialogDescription(h, "dialog", model.dialog.id, [
							"Adds the current query for ",
							h.span([h.Class("font-mono")], [inputs.metricName]),
							" as a chart widget.",
						]),
					]),
					body(h, model),
				],
			},
		}),
)
