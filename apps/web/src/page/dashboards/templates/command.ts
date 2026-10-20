import { DashboardTemplateId } from "@maple/domain/http"
import { LIST_LIMIT_MAX } from "@maple/domain/http/v2"
import { listMetrics } from "@maple/web-data/warehouse/metrics"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { fetchWidgetData, toWidgetFailure } from "../kit/widget-data"
import { awaitTxid } from "../kit/store"
import { Message } from "./message"

export const ReadClock = Command.define("ReadTemplatesClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

/** `retainedQueryV2("dashboards", "listTemplates", { query: { limit: LIST_LIMIT_MAX } })`. */
export const FetchTemplates = Command.define("FetchDashboardTemplates", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchTemplates],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.dashboards.listTemplates({ query: { limit: LIST_LIMIT_MAX } })
			return response.data
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTemplates({ key, result })),
		),
})

/** Readiness reads the org's metric names from the last 24 h (`METRIC_LIMIT` 1000). */
export const FetchMetrics = Command.define("FetchTemplateReadinessMetrics", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMetrics],
	execute: ({ key }) =>
		listMetrics({ data: { limit: 1000 } }).pipe(
			Effect.map((response) =>
				response.data.map((metric) => ({ metricName: metric.metricName, lastSeen: metric.lastSeen })),
			),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMetrics({ key, result })),
		),
})

/** `SELECTION_DEBOUNCE_MS`: a template must stay selected this long before its preview queries. */
export const WaitPreviewDelay = Command.define("WaitTemplatePreviewDelay", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedPreviewDelay],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(250)), Message.ElapsedPreviewDelay({ generation })),
})

/** `ToolbarSearch`'s 300 ms debounce before the query applies. */
export const WaitSearchDebounce = Command.define("WaitTemplatesSearchDebounce", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ generation })),
})

const decodeTemplateId = Schema.decodeUnknownEffect(DashboardTemplateId)

const parametersPayload = (parameters: Readonly<Record<string, string>>) => {
	const entries = Object.entries(parameters).filter(([, value]) => value.trim().length > 0)
	return entries.length > 0 ? { parameters: Object.fromEntries(entries) } : {}
}

/** `previewTemplate`: the template's own build for these parameters, nothing persisted. */
export const FetchPreview = Command.define("FetchDashboardTemplatePreview", {
	args: {
		key: Schema.String,
		templateId: Schema.String,
		parameters: Schema.Record(Schema.String, Schema.String),
	},
	messages: [Message.CompletedFetchPreview],
	execute: ({ key, templateId, parameters }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const template_id = yield* decodeTemplateId(templateId)
			return yield* client.dashboards.previewTemplate({
				params: { template_id },
				payload: parametersPayload(parameters),
			})
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPreview({ key, result })),
		),
})

export const FetchWidget = Command.define("FetchTemplatePreviewWidget", {
	args: {
		key: Schema.String,
		endpoint: Schema.String,
		params: Schema.Record(Schema.String, Schema.Unknown),
	},
	messages: [Message.CompletedFetchWidget],
	execute: ({ key, endpoint, params }) =>
		fetchWidgetData(endpoint, params).pipe(
			Effect.mapError(toWidgetFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchWidget({ key, result })),
		),
})

/** `instantiateTemplate`: the dashboard is created now; its txid is reconciled in the background. */
export const CreateFromTemplate = Command.define("CreateDashboardFromTemplate", {
	args: { templateId: Schema.String, parameters: Schema.Record(Schema.String, Schema.String) },
	messages: [Message.CompletedCreate],
	execute: ({ templateId, parameters }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const template_id = yield* decodeTemplateId(templateId)
			const created = yield* client.dashboards.instantiateTemplate({
				params: { template_id },
				payload: Object.keys(parameters).length > 0 ? { parameters } : {},
			})
			return { id: created.id, name: created.name, txid: created.txid ?? null }
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedCreate({ result })),
		),
})

/** `reconcileTxid`: waits for the new row on the shape stream; nothing waits on it. */
export const AwaitCreated = Command.define("AwaitCreatedDashboard", {
	args: { orgId: Schema.String, id: Schema.String, txid: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedAwaitCreated],
	execute: ({ orgId, id, txid }) =>
		Effect.as(awaitTxid(orgId, txid ?? undefined), Message.CompletedAwaitCreated({ id })),
})

/** `useContainerSize` on the preview grid: its width picks the column count. */
export const MeasurePreview = Mount.defineStream("MeasureTemplatePreview", {
	messages: [Message.MeasuredPreview],
	execute: ({ element }) =>
		Stream.callback<typeof Message.MeasuredPreview.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					Queue.offerUnsafe(
						queue,
						Message.MeasuredPreview({ width: element.getBoundingClientRect().width }),
					)
					const observer = new ResizeObserver((entries) => {
						const entry = entries.at(-1)
						if (entry !== undefined)
							Queue.offerUnsafe(
								queue,
								Message.MeasuredPreview({ width: entry.contentRect.width }),
							)
					})
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
