import { Clock, Effect, Result, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { randomUUID } from "node:crypto"
import {
	DashboardId,
	DashboardWidgetSchema,
	type DashboardConcurrencyError,
	type DashboardNotFoundError,
	type DashboardPersistenceError,
	type DashboardStoredConfigInvalidError,
	type DashboardValidationError,
	IsoDateTimeString,
	WidgetDataSourceSchema,
	defaultWidgetLayout,
	findNextPosition,
	WIDGET_TYPES,
	type DashboardDocument,
	type PanelType,
	widgetTypeByVisualization,
	withWidgets,
} from "@maple/domain/http"
import type { DashboardRow } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "./query-warehouse"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { McpInvalidInputError, McpQueryError } from "../tools/types"

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

export type DashboardWidget = typeof DashboardWidgetSchema.Type

const decodeIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)

const parseJsonValue = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

const jsonTransformation = (hint: (value: unknown) => string | undefined) =>
	SchemaTransformation.transformEffect<unknown, string>({
		decode: (text) =>
			parseJsonValue(text).pipe(
				Effect.mapError((error) => error.issue),
				Effect.flatMap((value) => {
					const message = hint(value)
					return message === undefined
						? Effect.succeed(value)
						: Effect.fail(new SchemaIssue.InvalidValue({ message }, value))
				}),
			),
		encode: (value) => Effect.succeed(JSON.stringify(value)),
	})

const noHint = (): undefined => undefined

/** Published like `P.json`, so every JSON-text parameter carries the same media type. */
const JSON_MEDIA_TYPE = "application/json"

/**
 * A JSON-in-a-string parameter, published as a plain string and decoded against `schema`.
 *
 * `P.json` would also publish the object form, and the dashboard schemas run to 10-23 KB of JSON
 * Schema each; `describe_dashboard_schema` is where their shape is documented. `hint` may reject
 * a parsed value with a corrective message before the schema's own (much longer) failure.
 */
// BOUNDARY: `hint` reads the parsed JSON before the schema decodes it.
export const jsonText = <S extends Schema.Codec<unknown, unknown, never, never>>(
	schema: S,
	description: string,
	hint: (value: unknown) => string | undefined = noHint,
) =>
	Schema.String.annotate({ description, contentMediaType: JSON_MEDIA_TYPE }).pipe(
		Schema.decodeTo(schema, jsonTransformation(hint)),
	)

/**
 * The optional form. The description goes on the property: a schema with an identifier (a
 * `Schema.Class`, the data-source union) publishes as a `$ref`, which would otherwise carry it.
 */
// BOUNDARY: `hint` reads the parsed JSON before the schema decodes it.
export const optionalJsonText = <S extends Schema.Codec<unknown, unknown, never, never>>(
	schema: S,
	description: string,
	hint: (value: unknown) => string | undefined = noHint,
) =>
	Schema.optional(Schema.String.pipe(Schema.decodeTo(schema, jsonTransformation(hint)))).annotate({
		description,
		contentMediaType: JSON_MEDIA_TYPE,
	})

/**
 * v2 data sources were `{ endpoint, params }`; v3 is a `kind`-discriminated
 * union. The MCP tool descriptions taught v2 long after the decoders moved to
 * v3, so this shape is what an agent trained on the old text — or on a stale
 * transcript — still sends. The raw decode error for a four-arm union is a wall
 * of per-arm failures that buries the one thing worth saying.
 *
 * Detection is deliberately narrow (a string `endpoint`, no `kind`) and the
 * result is an ERROR, not a coercion. `fromLegacyDataSource` would happily
 * convert this, but it is total by design — an endpoint name the agent invented
 * falls through to a `route` source and persists as a permanently blank widget.
 * Failing loudly with the v3 equivalent is the correction; guessing is not.
 */
const LegacyDataSource = Schema.Struct({
	endpoint: Schema.String,
	// A v3 source always carries `kind`; its absence is what identifies the legacy shape.
	kind: Schema.optionalKey(Schema.Undefined),
})

const decodeLegacyDataSource = Schema.decodeUnknownResult(LegacyDataSource)

export const legacyDataSourceHint = (value: unknown): string | undefined => {
	const decoded = decodeLegacyDataSource(value)
	if (Result.isFailure(decoded)) return undefined

	const { endpoint } = decoded.success
	const equivalent =
		endpoint === "markdown_static"
			? '{"kind":"static"}'
			: endpoint === "raw_sql_chart"
				? '{"kind":"raw_sql","sql":"SELECT …"}'
				: endpoint.startsWith("custom_query_builder_")
					? `{"kind":"query","resultShape":"${endpoint.slice("custom_query_builder_".length)}","queries":[…]}`
					: `{"kind":"route","endpoint":"${endpoint}","params":{…}}`

	return (
		`This is the legacy v2 data-source shape (\`{"endpoint":"${endpoint}", …}\`). ` +
		`Widgets now use a \`kind\`-discriminated union — the v3 equivalent is \`${equivalent}\`. ` +
		"Note that a `query` source spreads `queries`/`formulas` at the TOP LEVEL (not under `params`) " +
		'and requires `resultShape`. Call `describe_dashboard_schema` with `section: "data_sources"` for the full shapes.'
	)
}

/** The same hint, one level in: a whole widget whose `dataSource` is the v2 shape. */
const decodeWidgetDataSourceField = Schema.decodeUnknownResult(Schema.Struct({ dataSource: Schema.Unknown }))

export const legacyWidgetDataSourceHint = (value: unknown): string | undefined => {
	const decoded = decodeWidgetDataSourceField(value)
	return Result.isFailure(decoded) ? undefined : legacyDataSourceHint(decoded.success.dataSource)
}

/** `data_source_json`: a v3 data source, with the v2 shape rejected by name. */
export const dataSourceJson = (description: string) =>
	jsonText(WidgetDataSourceSchema, description, legacyDataSourceHint)

export const optionalDataSourceJson = (description: string) =>
	optionalJsonText(WidgetDataSourceSchema, description, legacyDataSourceHint)

/** `widget_json`: one whole widget. */
export const widgetJson = (description: string) =>
	jsonText(DashboardWidgetSchema, description, legacyWidgetDataSourceHint)

/** The {@link DashboardRow} every dashboard tool reports. */
export const toDashboardRow = (dashboard: DashboardDocument): typeof DashboardRow.Type => ({
	id: dashboard.id,
	name: dashboard.name,
	...(dashboard.description === undefined ? undefined : { description: dashboard.description }),
	...(dashboard.tags === undefined ? undefined : { tags: [...dashboard.tags] }),
	widgetCount: dashboard.widgets.length,
	createdAt: dashboard.createdAt,
	updatedAt: dashboard.updatedAt,
})

export const dashboardNotFound = (dashboardId: string) =>
	new McpInvalidInputError({
		message: `Dashboard not found: ${dashboardId}. Use list_dashboards to find available dashboard IDs.`,
		parameter: "dashboard_id",
	})

type DashboardServiceError =
	| DashboardNotFoundError
	| DashboardValidationError
	| DashboardPersistenceError
	| DashboardStoredConfigInvalidError
	| DashboardConcurrencyError

/** Persistence failures as MCP errors: a missing or rejected document is the caller's to fix, the rest are ours. */
export const toMcpDashboardError =
	(tool: string) =>
	(error: DashboardServiceError): McpInvalidInputError | McpQueryError => {
		switch (error._tag) {
			case "@maple/http/errors/DashboardNotFoundError":
				return dashboardNotFound(error.dashboardId)
			case "@maple/http/errors/DashboardValidationError":
				return new McpInvalidInputError({
					message:
						error.details.length === 0
							? error.message
							: `${error.message}\n- ${error.details.join("\n- ")}`,
				})
			default:
				return new McpQueryError({ message: error.message, pipeName: tool, cause: error })
		}
	}

export const generateWidgetId = (): string => randomUUID()

/**
 * Default grid size per visualization type — the same table the web store reads,
 * so an MCP-added widget matches what the "Add widget" UI would produce. A gauge
 * is the one deliberate difference: agents get the narrow tile.
 */
export const defaultSizeForVisualization = (visualization: string): { w: number; h: number } => {
	const { w, h } = defaultWidgetLayout(visualization)
	return { w: widgetTypeByVisualization(visualization)?.mcpWidth ?? w, h }
}

/**
 * Grid size by panel type.
 *
 * The `visualization` variant above cannot tell a bar from a line (both persist
 * as `"chart"`), and more importantly `widgetTypeByVisualization("chart")`
 * resolves to `line`, so any per-type `mcpWidth` on a chart-family panel would
 * be lost. Callers that have resolved a panel type should use this.
 */
export const defaultSizeForPanelType = (panelType: PanelType): { w: number; h: number } => {
	const meta = WIDGET_TYPES[panelType]
	return { w: meta.mcpWidth ?? meta.defaultLayout.w, h: meta.defaultLayout.h }
}

/**
 * Auto-layout is the shared `findNextPosition` from `@maple/widgets`, so a
 * widget an agent adds lands exactly where the "Add widget" button would put it.
 * This used to be a hand-maintained port of the web copy.
 */
export { findNextPosition as findNextWidgetPosition }

/**
 * Shared workflow: resolve tenant, load dashboard by id, run a pure transform
 * over its widgets, and persist the result. The transform receives the
 * existing widgets and should return the new widget array; any other change
 * (rename, description, etc.) should stay on the dedicated `update_dashboard`
 * tool.
 *
 * Concurrency: delegates to `persistence.mutate`, which uses a compare-and-swap
 * on `dashboards.version`. If a concurrent writer (another MCP call or web
 * edit) lands between our read and write the transform is re-applied on top
 * of the new state and retried. After exhausting the retry budget the caller
 * receives a `DashboardConcurrencyError` (mapped here to `McpQueryError`),
 * which is preferable to a silent lost update.
 */
export const withDashboardMutation = Effect.fn("withDashboardMutation")(function* (
	dashboardId: string,
	tool: string,
	transform: (
		existingWidgets: ReadonlyArray<DashboardWidget>,
	) => Effect.Effect<ReadonlyArray<DashboardWidget>, McpInvalidInputError>,
) {
	const tenant = yield* CurrentMcpTenant
	const persistence = yield* DashboardPersistenceService

	const dashboardIdBranded = yield* decodeDashboardId(dashboardId).pipe(
		Effect.mapError(
			() =>
				new McpInvalidInputError({
					message: `Invalid dashboard_id: ${dashboardId}. Use list_dashboards to find available dashboard IDs.`,
					parameter: "dashboard_id",
				}),
		),
	)

	return yield* persistence
		.mutate(tenant.orgId, tenant.userId, dashboardIdBranded, (existing) =>
			Effect.gen(function* () {
				const nextWidgets = yield* transform(existing.widgets)
				const nowMillis = yield* Clock.currentTimeMillis
				const now = decodeIsoDateTimeString(new Date(nowMillis).toISOString())

				// Everything but the widgets and `updatedAt` is carried forward
				// wholesale. Naming the fields here is exactly what used to drop
				// `sections`, `variables` and `refreshIntervalSeconds` from every
				// dashboard an agent touched.
				return withWidgets(existing, nextWidgets, now)
			}),
		)
		.pipe(
			Effect.mapError((error) =>
				error instanceof McpInvalidInputError ? error : toMcpDashboardError(tool)(error),
			),
		)
})
