import { defaultWidgetLayout, TimeRangeSchema } from "@maple/domain/http"
import { resolveRelativeRangeToWarehouse } from "@maple/query-engine"
import { MetricsQueryDraftSchema } from "@maple/query-model"
import { makeQueryDataSource } from "@maple/widgets/dashboard"
import { Clock, Effect, Option, Random, Result, Schema, Stream, Array as Arr, String as Str } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { countLabel } from "@maple/ui/lib/format"
import { button } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { errorState } from "@maple/views/ui/error-state"
import { input } from "@maple/views/ui/input"
import { pressable } from "@maple/views/ui/pressable"
import { defineMessageUnion } from "foldkit/message"
import { rowToDocument } from "../../../data/collections/dashboards"
import { trackProduct } from "../../../data/analytics"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { liveQueryStream } from "../../../data/live-query"
import { orgLive } from "../../../data/collections/org-collections"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "@maple/views/ui/dialog"
import { generateWidgetId, withAddedWidget } from "../../dashboards/kit/layout"
import { createPayload } from "../../dashboards/kit/portable"
import { awaitTxid, mutateDashboard } from "../../dashboards/kit/store"
import { inferDisplayUnitForQuery } from "../../dashboards/widget/drafts"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

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

type TimeRange = typeof TimeRangeSchema.Type

const decodeTimeRange = Schema.decodeUnknownOption(TimeRangeSchema)

/** The explorer's window as a new dashboard's range: its absolute range when set, else its preset. */
export const explorerTimeRangeOf = (
	search: Readonly<{
		startTime?: string | undefined
		endTime?: string | undefined
		timePreset?: string | undefined
	}>,
	defaultPreset: string,
): TimeRange =>
	Option.getOrElse(
		decodeTimeRange({ type: "absolute", startTime: search.startTime, endTime: search.endTime }),
		() => ({ type: "relative", value: readablePreset(search.timePreset) ?? defaultPreset }),
	)

/** A hand-edited `timePreset` the resolver cannot read is dropped, so the explorer's fallback is saved. */
const readablePreset = (preset: string | undefined): string | undefined =>
	preset !== undefined && resolveRelativeRangeToWarehouse(preset, 0, "UTC") !== null ? preset : undefined

/** `widgetDisplay` and `buildWidgetDataSource`: a fresh query id, never the explorer's own. */
export const widgetOf = (draft: typeof MetricsQueryDraftSchema.Type, queryId: string) => {
	const unit = inferDisplayUnitForQuery(draft)
	return {
		visualization: "chart" as const,
		dataSource: makeQueryDataSource({ resultShape: "timeseries", queries: [{ ...draft, id: queryId }] }),
		display: {
			title: draft.metricName,
			chartId: "query-builder-area",
			...(unit === undefined ? undefined : { unit }),
		},
	}
}

export const AddWidget = Command.define("AddMetricWidgetToDashboard", {
	args: { orgId: Schema.String, dashboardId: Schema.String, draft: MetricsQueryDraftSchema },
	messages: [Message.CompletedAddWidget],
	execute: ({ orgId, dashboardId, draft }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const random = yield* Random.next
			const id = generateWidgetId(nowMs, random)
			const secureRandom = yield* SecureRandom.SecureRandom
			const queryId = yield* secureRandom.uuidV4()
			const widget = widgetOf(draft, queryId)
			// The write is awaited: a failed persist keeps the dialog open with its error, never a navigation.
			yield* mutateDashboard(orgId, dashboardId, (document, nowIso) =>
				withAddedWidget(document, { id, ...widget, layout: defaultWidgetLayout("chart") }, nowIso),
			)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedAddWidget({ dashboardId, result })),
		),
})

/** `importDashboard` with the widget in it: one create, so a not-yet-synced board cannot drop it. */
export const CreateDashboard = Command.define("CreateDashboardWithMetricWidget", {
	args: {
		orgId: Schema.String,
		name: Schema.String,
		draft: MetricsQueryDraftSchema,
		timeRange: TimeRangeSchema,
	},
	messages: [Message.CompletedCreateDashboard],
	execute: ({ orgId, name, draft, timeRange }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const random = yield* SecureRandom.SecureRandom
			const widgetId = yield* random.uuidV4()
			const queryId = yield* random.uuidV4()
			const widget = { id: widgetId, ...widgetOf(draft, queryId) }
			const created = yield* client.dashboards.create({
				payload: createPayload({
					name,
					timeRange,
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
					dashboards: Arr.flatMap(rows, (row) =>
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

type Context = Readonly<{
	orgId: string
	draft: typeof MetricsQueryDraftSchema.Type | null
	/** The explorer's window: a dashboard created here opens on it. */
	timeRange: TimeRange
}>

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
						model: { ...model, addingTo: dashboardId, error: null },
						commands: [AddWidget({ orgId: context.orgId, dashboardId, draft: context.draft })],
					},
		// `handleCreate`: a blank name or a create in flight does nothing.
		ClickedCreate: () => {
			const name = Str.trim(model.newName)
			return name === "" || model.isCreating || model.addingTo !== null || context.draft === null
				? { model }
				: {
						model: { ...model, isCreating: true, error: null },
						commands: [
							CreateDashboard({
								orgId: context.orgId,
								name,
								draft: context.draft,
								timeRange: context.timeRange,
							}),
						],
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
								error: { title: "Couldn't add widget", failure },
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
						error: { title: "Couldn't create dashboard", failure },
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
	pressable(
		h,
		{
			onClick: Message.ClickedDashboard({ dashboardId: dashboard.id }),
			className:
				"flex w-full items-center justify-between gap-2 rounded-sm border px-3 py-2 text-left text-sm hover:bg-accent active:bg-accent",
			attributes: [h.Key(dashboard.id)],
		},
		[
			h.span([h.Class("truncate")], [dashboard.name]),
			typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, [
				countLabel(dashboard.widgetCount, "widget"),
			]),
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
							Arr.map(model.dashboards, (d) => choiceRow(h, d)),
						),
					]),
			hstack(h, { gap: "2" }, [
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
						isDisabled: Str.trim(model.newName) === "",
						isLoading: model.isCreating,
						attributes: [h.OnClick(Message.ClickedCreate())],
					},
					["Create & add"],
				),
			]),
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
