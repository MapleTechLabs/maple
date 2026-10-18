import { Effect, Schema } from "effect"
import { getTemplate, listTemplateMetadata } from "@maple/backend/dashboard-templates"
import type { TemplateParameterValues } from "@maple/backend/dashboard-templates"
import { paramKey } from "@maple/backend/dashboard-templates/helpers"
import { DashboardWidgetDataService } from "@maple/backend/services/dashboards/DashboardWidgetDataService"
import { resolveShareVariables } from "@maple/backend/services/dashboards/share-variables"
import { resolveShareWindow } from "@maple/backend/services/dashboards/share-window"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	DashboardDocument,
	DashboardTemplateMetadata,
	DashboardTemplateNotFoundError,
	SHARE_NOT_FOUND_MESSAGE,
	ShareNotFoundError,
	SharedDashboardResponse,
	ShareWidgetDataPayload,
	ShareWidgetDataResponse,
} from "@maple/domain/http"
import {
	paginateArray,
	V2DashboardCreateParams,
	V2DashboardDeleteResponse,
	V2DashboardMutation,
	V2DashboardPersesImportResponse,
	V2DashboardTemplate,
	V2DashboardTemplatePreview,
	V2DashboardTemplatePreviewParams,
	V2DashboardUpdateParams,
} from "@maple/domain/http/v2"
import { DashboardTemplateId, OrgId } from "@maple/domain/primitives"
import { MAX_LIST_RANGE_SECONDS, MAX_QUERY_RANGE_SECONDS } from "@maple/query-engine"
import { makeQueryEngineEvaluate, makeQueryEngineEvaluateSeries } from "@maple/query-engine/runtime"
// Not a declared dependency of ui-parity; the file imports only its own package's siblings.
import { redactForShare } from "@maple/widgets/dashboard"
import type { FixtureWarehouse } from "../../../backend/warehouse.ts"
import type { Dataset, EndpointHandler, SyncedRow } from "../../dataset.ts"
import { acmeAdmin, DAY, HOUR, isoBefore } from "../../identity.ts"
import { str } from "./synthetic.ts"
import { sectionsDashboard, variablesDashboard, widgetsDashboard } from "./dashboard-widgets.ts"

/**
 * Dashboards built from the API's own templates (`@maple/backend/dashboard-templates`), so their
 * widgets are the real kinds (stat, table, chart, list) and their queries run on the warehouse.
 */

export const PLATFORM_DASHBOARD_ID = "dash_parity_ops_platform"
export const PAYMENT_DASHBOARD_ID = "dash_parity_ops_payment"
/** A public link to the platform board (`/share/<token>`). */
export const PLATFORM_SHARE_TOKEN = "parity_share_platform"

const templateDashboard = (
	id: string,
	templateId: string,
	name: string,
	ageMs: number,
	params: TemplateParameterValues = {},
): SyncedRow => {
	const built = getTemplate(templateId)?.build(params)
	const createdAt = isoBefore(ageMs)
	const updatedAt = isoBefore(ageMs / 4)
	return {
		org_id: acmeAdmin.orgId,
		id,
		name,
		payload_json: {
			id,
			name,
			description: built?.description,
			timeRange: { type: "relative", value: "6h" },
			widgets: built?.widgets ?? [],
			...(built?.variables === undefined ? undefined : { variables: built.variables }),
			createdAt,
			updatedAt,
		},
		created_at: createdAt,
		updated_at: updatedAt,
		created_by: acmeAdmin.userId,
		updated_by: acmeAdmin.userId,
		version: 3,
	}
}

export const opsDashboards: ReadonlyArray<SyncedRow> = [
	templateDashboard(PLATFORM_DASHBOARD_ID, "platform-overview", "Platform overview", 12 * DAY),
	templateDashboard(PAYMENT_DASHBOARD_ID, "service-health", "Payment service health", 3 * HOUR, {
		[paramKey("service_name")]: "payment-svc",
	}),
	widgetsDashboard,
	sectionsDashboard,
	variablesDashboard,
]

const encodeTemplate = Schema.encodeSync(V2DashboardTemplate)
const encodePreview = Schema.encodeUnknownEffect(V2DashboardTemplatePreview)
const isPreviewParams = Schema.is(V2DashboardTemplatePreviewParams)
const templateParameters = (payload: unknown): TemplateParameterValues =>
	isPreviewParams(payload) ? (payload.parameters ?? {}) : {}
const decodeDocument = Schema.decodeUnknownEffect(DashboardDocument)

const sharedDocument = (dataset: Dataset, token: string) => {
	const row =
		token === PLATFORM_SHARE_TOKEN
			? (dataset.synced.dashboards ?? []).find((entry) => entry.id === PLATFORM_DASHBOARD_ID)
			: undefined
	return row === undefined
		? Effect.fail(new ShareNotFoundError({ message: SHARE_NOT_FOUND_MESSAGE }))
		: decodeDocument(row.payload_json)
}

const encodeShared = Schema.encodeUnknownEffect(SharedDashboardResponse)
const encodeWidgetData = Schema.encodeUnknownEffect(ShareWidgetDataResponse)
const isWidgetDataPayload = Schema.is(ShareWidgetDataPayload)

/** `DashboardWidgetDataService.make` over the fixture warehouse, built once like the API's layer. */
const makeWidgetData = (warehouse: FixtureWarehouse) =>
	Effect.runSync(
		DashboardWidgetDataService.make.pipe(
			Effect.provideService(QueryEngineService, {
				execute: (tenant, request) => warehouse.executeQuery(tenant, request),
				evaluate: makeQueryEngineEvaluate(warehouse.executor),
				evaluateSeries: makeQueryEngineEvaluateSeries(warehouse.executor),
				// No edge cache in the fixture: the direct-route effect runs as is.
				cachedDirect: (_tenant, _route, _payload, effect) => effect,
			}),
			Effect.provideService(WarehouseQueryService, warehouse.executor),
		),
	)

/** Per-widget failures ride inside the 200, as the API maps them. */
const failedWidget =
	(widgetId: string, reason: "not_found" | "unsupported" | "failed") =>
	(error: { readonly message: string }) =>
		Effect.succeed({ widgetId, ok: false as const, reason, message: error.message })

/** The id a fixture `create` hands out; the shape stream never carries it (no live sync). */
export const CREATED_DASHBOARD_ID = "dash_parity_created"
/**
 * Every write answers with this txid. The fixture Electric server never streams it back, so the
 * app keeps its optimistic state until TanStack DB's 15 s txid wait, long after the screenshot.
 */
const FIXTURE_TXID = "4242"

const encodeMutation = Schema.encodeUnknownEffect(V2DashboardMutation)
const encodeDeleted = Schema.encodeUnknownEffect(V2DashboardDeleteResponse)
const encodePersesImport = Schema.encodeUnknownEffect(V2DashboardPersesImportResponse)
// Handlers receive the request already decoded, so it is checked against the Type side.
const decodeCreateParams = Schema.decodeUnknownEffect(Schema.toType(V2DashboardCreateParams))
const decodeUpdateParams = Schema.decodeUnknownEffect(Schema.toType(V2DashboardUpdateParams))

type MutationFields = {
	readonly name: string
	readonly description?: string | null
	readonly tags?: ReadonlyArray<string>
	readonly timeRange?: unknown
	readonly widgets?: ReadonlyArray<unknown>
	readonly sections?: ReadonlyArray<unknown>
	readonly variables?: ReadonlyArray<unknown>
	readonly refreshIntervalSeconds?: number | null
}

/** The committed object a write returns, stamped at the dataset's frozen `now`. */
const mutation = (id: string, fields: MutationFields) => {
	const now = isoBefore(0)
	return encodeMutation({
		id,
		object: "dashboard",
		name: fields.name,
		description: fields.description ?? null,
		tags: fields.tags ?? [],
		timeRange: fields.timeRange ?? { type: "relative", value: "12h" },
		widgets: fields.widgets ?? [],
		sections: fields.sections ?? [],
		variables: fields.variables ?? [],
		refreshIntervalSeconds: fields.refreshIntervalSeconds ?? null,
		createdAt: now,
		updatedAt: now,
		txid: FIXTURE_TXID,
	})
}

/** `dashboards.create` / `update` / `delete` / `importPerses`, answered without persisting. */
const writeEndpoints: Readonly<Record<string, EndpointHandler>> = {
	"dashboards.create": ({ payload }) =>
		Effect.flatMap(decodeCreateParams(payload), (params) => mutation(CREATED_DASHBOARD_ID, params)),
	"dashboards.update": ({ params, payload }) =>
		Effect.flatMap(decodeUpdateParams(payload), (update) =>
			mutation(str(params, "id") ?? "", { ...update, name: update.name ?? "" }),
		),
	// The API's `instantiateTemplate`: the template's own build, answered as the created board.
	"dashboards.instantiateTemplate": ({ params, payload }) => {
		const built = getTemplate(str(params, "template_id") ?? "")?.build(templateParameters(payload))
		return mutation(CREATED_DASHBOARD_ID, {
			name: built?.name ?? "Untitled Dashboard",
			description: built?.description ?? null,
			timeRange: built?.timeRange,
			widgets: built?.widgets ?? [],
			variables: built?.variables ?? [],
		})
	},
	"dashboards.delete": ({ params }) =>
		encodeDeleted({
			id: str(params, "id") ?? "",
			object: "dashboard",
			deleted: true,
			txid: FIXTURE_TXID,
		}),
	"dashboards.importPerses": () =>
		Effect.flatMap(
			Effect.flatMap(
				mutation(CREATED_DASHBOARD_ID, { name: "Imported from Perses" }),
				Schema.decodeUnknownEffect(V2DashboardMutation),
			),
			(dashboard) => encodePersesImport({ object: "dashboard_import", dashboard, warnings: [] }),
		),
}

export const dashboardEndpoints = (
	warehouse: FixtureWarehouse,
): Readonly<Record<string, EndpointHandler>> => {
	const service = makeWidgetData(warehouse)
	return {
		...writeEndpoints,
		"dashboards.listTemplates": ({ query }) =>
			Effect.map(
				paginateArray(
					listTemplateMetadata().map((template) =>
						encodeTemplate({ ...template, object: "dashboard_template" }),
					),
					{ limit: Number(str(query, "limit") ?? "100") },
				),
				(page) => ({ object: "list", ...page }),
			),
		// The API's read-only `previewTemplate`: the template's own pure build, nothing persisted.
		"dashboards.previewTemplate": ({ params, payload }) =>
			Effect.gen(function* () {
				const id = str(params, "template_id") ?? ""
				const template = getTemplate(id)
				if (template === undefined)
					return yield* new DashboardTemplateNotFoundError({
						templateId: DashboardTemplateId.make(id),
						message: "No such dashboard template.",
					})
				const built = template.build(templateParameters(payload))
				return yield* encodePreview({
					object: "dashboard_template_preview",
					name: built.name,
					timeRange: built.timeRange,
					widgets: built.widgets,
					variables: built.variables ?? [],
				})
			}),
		"sharePublic.resolve": ({ dataset, payload }) =>
			Effect.gen(function* () {
				const document = yield* sharedDocument(dataset, str(payload, "token") ?? "")
				return yield* encodeShared(
					new SharedDashboardResponse({
						mode: "public",
						scope: "dashboard",
						dashboard: redactForShare(document, null),
						limits: {
							maxRangeSeconds: MAX_QUERY_RANGE_SECONDS,
							maxListRangeSeconds: MAX_LIST_RANGE_SECONDS,
						},
						embeddable: false,
					}),
				)
			}),
		"sharePublic.widgetData": ({ dataset, payload }) =>
			Effect.gen(function* () {
				if (!isWidgetDataPayload(payload))
					return yield* new ShareNotFoundError({ message: SHARE_NOT_FOUND_MESSAGE })
				const document = yield* sharedDocument(dataset, payload.token)
				const orgId = OrgId.make(acmeAdmin.orgId)
				const window = yield* resolveShareWindow(payload.timeRange)
				const definitions = document.variables ?? []
				const options = yield* service.variableOptions(orgId, definitions, window)
				const variableValues = yield* resolveShareVariables(
					definitions,
					payload.variableValues ?? {},
					options,
					[],
				)
				const results = yield* Effect.forEach(payload.requests, (request) =>
					service
						.resolve(
							orgId,
							document,
							{
								widgetId: request.widgetId,
								source: request.source ?? "primary",
								...(request.maxDataPoints === undefined
									? undefined
									: { maxDataPoints: request.maxDataPoints }),
							},
							window,
							variableValues,
						)
						.pipe(
							Effect.map((resolved) => ({
								widgetId: request.widgetId,
								ok: true as const,
								data: resolved.data,
								...(resolved.narrowedToSeconds === undefined
									? undefined
									: { narrowedToSeconds: resolved.narrowedToSeconds }),
							})),
							Effect.catchTags({
								"@maple/http/errors/ShareWidgetNotFoundError": failedWidget(
									request.widgetId,
									"not_found",
								),
								"@maple/http/errors/ShareUnsupportedWidgetError": failedWidget(
									request.widgetId,
									"unsupported",
								),
								"@maple/http/errors/ShareWidgetExecutionError": failedWidget(
									request.widgetId,
									"failed",
								),
							}),
						),
				)
				const variables = Object.fromEntries(
					Object.entries(variableValues).flatMap(([name, resolved]) =>
						resolved === undefined ? [] : [[name, resolved.value]],
					),
				)
				return yield* encodeWidgetData(new ShareWidgetDataResponse({ results, variables }))
			}),
	}
}
