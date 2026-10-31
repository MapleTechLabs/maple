import {
	V2DashboardCreateParams,
	V2DashboardWidget,
	V2DashboardVariable,
	V2DashboardSection,
	V2TimeRange,
} from "./dashboard-data"
export {
	V2DashboardCreateParams,
	V2DashboardWidget,
	V2DashboardVariable,
	V2DashboardSection,
	V2TimeRange,
	V2WidgetDataSource,
	V2WidgetDisplay,
	V2WidgetLayout,
} from "./dashboard-data"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	DashboardId,
	DashboardShareId,
	DashboardTemplateCategory,
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	DashboardVersionId,
	PostgresTransactionId,
	UserId,
} from "../../primitives"
import {
	DashboardConcurrencyError,
	DashboardNotFoundError,
	DashboardPersistenceError,
	DashboardStoredConfigInvalidError,
	DashboardRefreshIntervalSeconds,
	DashboardTemplateNotFoundError,
	DashboardTemplatePreviewKind,
	DashboardValidationError,
	DashboardVersionNotFoundError,
	DashboardVersionChangeKind,
} from "../dashboards"
import {
	DashboardShareMode,
	SHARE_WIDGET_BATCH_MAX,
	ShareNotConfiguredError,
	ShareNotFoundError,
	SharePersistenceError,
	ShareWidgetNotFoundError,
} from "../share"
import { WireValue } from "../../wire"
import { AuditedRead } from "../audit-log"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import {
	V2InsufficientPermissions,
	V2ParameterInvalid,
	V2ParameterMissing,
	V2TimeRangeInvalid,
} from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"
import { publicErrors } from "./public-error"

export const DashboardPublicId = PublicId(PublicIdPrefixes.dashboard, DashboardId)
export const DashboardVersionPublicId = PublicId(PublicIdPrefixes.dashboardVersion, DashboardVersionId)
export const DashboardTemplatePublicId = PublicId(PublicIdPrefixes.dashboardTemplate, DashboardTemplateId)
export const DashboardSharePublicId = PublicId(PublicIdPrefixes.dashboardShare, DashboardShareId)

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const StringRecord = Schema.Record(Schema.String, Schema.String)

const dashboardFields = {
	id: DashboardPublicId,
	object: Schema.Literal("dashboard"),
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	tags: Schema.Array(Schema.String),
	timeRange: V2TimeRange,
	widgets: Schema.Array(V2DashboardWidget),
	// Always present, `[]` when the dashboard is one flat canvas — matching how
	// `tags` and `variables` read on this resource.
	sections: Schema.Array(V2DashboardSection),
	variables: Schema.Array(V2DashboardVariable),
	// `null` is off, matching `description`'s absence convention on this resource.
	refreshIntervalSeconds: Schema.NullOr(DashboardRefreshIntervalSeconds),
	createdAt: Timestamp,
	updatedAt: Timestamp,
}

export const V2Dashboard = Schema.Struct(dashboardFields)
	.pipe(
		Schema.encodeKeys({
			timeRange: "time_range",
			refreshIntervalSeconds: "refresh_interval_seconds",
			createdAt: "created_at",
			updatedAt: "updated_at",
		}),
	)
	.annotate({
		identifier: "Dashboard",
		title: "Dashboard",
		description: "A complete Maple dashboard definition, including its widgets and variables.",
	})
export type V2Dashboard = Schema.Schema.Type<typeof V2Dashboard>

export const V2DashboardMutation = Schema.Struct({
	...dashboardFields,
	txid: optional(PostgresTransactionId),
})
	.pipe(
		Schema.encodeKeys({
			timeRange: "time_range",
			refreshIntervalSeconds: "refresh_interval_seconds",
			createdAt: "created_at",
			updatedAt: "updated_at",
		}),
	)
	.annotate({
		identifier: "DashboardMutationResponse",
		title: "Dashboard mutation response",
		description:
			"The committed dashboard. `txid` is optional reconciliation metadata for ElectricSQL-integrated clients; other public API consumers do not need it.",
	})
export type V2DashboardMutation = Schema.Schema.Type<typeof V2DashboardMutation>

export const V2DashboardUpdateParams = Schema.Struct({
	name: optional(Schema.String.check(Schema.isMinLength(1))),
	description: optional(Schema.NullOr(Schema.String)),
	tags: optional(Schema.Array(Schema.String)),
	timeRange: optional(V2TimeRange),
	widgets: optional(Schema.Array(V2DashboardWidget)),
	sections: optional(Schema.Array(V2DashboardSection)),
	variables: optional(Schema.Array(V2DashboardVariable)),
	refreshIntervalSeconds: optional(Schema.NullOr(DashboardRefreshIntervalSeconds)),
})
	.pipe(
		Schema.encodeKeys({
			timeRange: "time_range",
			refreshIntervalSeconds: "refresh_interval_seconds",
		}),
	)
	.annotate({
		identifier: "DashboardUpdateParams",
		title: "Dashboard update parameters",
		description: "Fields to update. Omitted fields retain their current values.",
		parseOptions: { reportInput: true },
	})
export type V2DashboardUpdateParams = Schema.Schema.Type<typeof V2DashboardUpdateParams>

export const V2DashboardDeleteResponse = Schema.Struct({
	id: DashboardPublicId,
	object: Schema.Literal("dashboard"),
	deleted: Schema.Literal(true),
	txid: optional(PostgresTransactionId),
}).annotate({
	identifier: "DashboardDeleted",
	title: "Deleted dashboard",
	description:
		"A dashboard deletion tombstone. `txid` is optional reconciliation metadata for ElectricSQL-integrated clients.",
})
export type V2DashboardDeleteResponse = Schema.Schema.Type<typeof V2DashboardDeleteResponse>

const versionFields = {
	id: DashboardVersionPublicId,
	object: Schema.Literal("dashboard_version"),
	dashboardId: DashboardPublicId,
	versionNumber: Schema.Number,
	changeKind: DashboardVersionChangeKind,
	changeSummary: Schema.NullOr(Schema.String),
	sourceVersionId: Schema.NullOr(DashboardVersionPublicId),
	createdAt: Timestamp,
	createdBy: UserId,
}

export const V2DashboardVersion = Schema.Struct(versionFields)
	.pipe(
		Schema.encodeKeys({
			dashboardId: "dashboard_id",
			versionNumber: "version_number",
			changeKind: "change_kind",
			changeSummary: "change_summary",
			sourceVersionId: "source_version_id",
			createdAt: "created_at",
			createdBy: "created_by",
		}),
	)
	.annotate({ identifier: "DashboardVersion", title: "Dashboard version" })
export type V2DashboardVersion = Schema.Schema.Type<typeof V2DashboardVersion>

export const V2DashboardVersionDetail = Schema.Struct({
	...versionFields,
	snapshot: V2Dashboard,
})
	.pipe(
		Schema.encodeKeys({
			dashboardId: "dashboard_id",
			versionNumber: "version_number",
			changeKind: "change_kind",
			changeSummary: "change_summary",
			sourceVersionId: "source_version_id",
			createdAt: "created_at",
			createdBy: "created_by",
		}),
	)
	.annotate({ identifier: "DashboardVersionDetail", title: "Dashboard version detail" })
export type V2DashboardVersionDetail = Schema.Schema.Type<typeof V2DashboardVersionDetail>

const V2DashboardTemplateParameter = Schema.Struct({
	key: DashboardTemplateParameterKey,
	label: Schema.String,
	description: Schema.String,
	required: Schema.Boolean,
	placeholder: optional(Schema.String),
})

const V2DashboardTemplatePreviewWidget = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	kind: DashboardTemplatePreviewKind,
	title: Schema.String,
})

export const V2DashboardTemplateRequirement = Schema.Struct({
	kind: Schema.Literals(["metrics", "integration", "telemetry"]).annotate({
		description:
			"`metrics` is gated on `required_metric_prefixes`, `integration` on a connected integration, `telemetry` is never gated.",
	}),
	label: Schema.String.annotate({
		description: "Full prose — the same string the `requirements` array carries.",
	}),
	missing: optional(
		Schema.String.annotate({
			description:
				'Short statement of what is missing, e.g. "no metrics". Usually absent; clients derive `no <prefix>*` from `required_metric_prefixes`.',
		}),
	),
	collector: Schema.String.annotate({
		description: 'Noun phrase naming what emits the data, read as "Collected by {collector}."',
	}),
	setupLabel: optional(
		Schema.String.annotate({
			description: 'Noun phrase read as "Set up {setup_label}". Absent for `telemetry`.',
		}),
	),
	hint: optional(
		Schema.String.annotate({
			description: "One extra sentence shown when the template is gated.",
		}),
	),
})
	.pipe(Schema.encodeKeys({ setupLabel: "setup_label" }))
	.annotate({
		identifier: "DashboardTemplateRequirement",
		title: "Dashboard template requirement",
		description: "What an org needs before this template's widgets have anything to draw.",
	})
export type V2DashboardTemplateRequirement = Schema.Schema.Type<typeof V2DashboardTemplateRequirement>

export const V2DashboardTemplate = Schema.Struct({
	id: DashboardTemplatePublicId,
	object: Schema.Literal("dashboard_template"),
	name: Schema.String,
	description: Schema.String,
	category: DashboardTemplateCategory,
	tags: Schema.Array(Schema.String),
	requirements: Schema.Array(Schema.String),
	requirement: Schema.NullOr(V2DashboardTemplateRequirement),
	requiredMetricPrefixes: Schema.Array(Schema.String),
	parameters: Schema.Array(V2DashboardTemplateParameter),
	preview: Schema.Array(V2DashboardTemplatePreviewWidget),
})
	.pipe(Schema.encodeKeys({ requiredMetricPrefixes: "required_metric_prefixes" }))
	.annotate({
		identifier: "DashboardTemplate",
		title: "Dashboard template",
	})
export type V2DashboardTemplate = Schema.Schema.Type<typeof V2DashboardTemplate>

export const V2DashboardTemplatePreviewParams = Schema.Struct({
	parameters: optional(Schema.Record(DashboardTemplateParameterKey, Schema.String)),
}).annotate({
	identifier: "DashboardTemplatePreviewParams",
	title: "Dashboard template preview parameters",
})
export type V2DashboardTemplatePreviewParams = Schema.Schema.Type<typeof V2DashboardTemplatePreviewParams>

export const V2DashboardTemplatePreview = Schema.Struct({
	object: Schema.Literal("dashboard_template_preview"),
	name: Schema.String,
	timeRange: V2TimeRange,
	widgets: Schema.Array(V2DashboardWidget),
	variables: Schema.Array(V2DashboardVariable),
})
	.pipe(Schema.encodeKeys({ timeRange: "time_range" }))
	.annotate({
		identifier: "DashboardTemplatePreview",
		title: "Dashboard template preview",
		description:
			"The dashboard a template would build, without creating it. Nothing is persisted; the widgets are identical to what `instantiate` would save for the same parameters.",
	})
export type V2DashboardTemplatePreview = Schema.Schema.Type<typeof V2DashboardTemplatePreview>

export const V2DashboardTemplateInstantiateParams = Schema.Struct({
	parameters: optional(Schema.Record(DashboardTemplateParameterKey, Schema.String)),
	name: optional(Schema.String),
}).annotate({
	identifier: "DashboardTemplateInstantiateParams",
	title: "Dashboard template instantiate parameters",
})

export const V2DashboardPersesImportParams = Schema.Struct({
	dashboard: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "DashboardPersesImportParams", title: "Perses import parameters" })

export const V2DashboardPersesImportResponse = Schema.Struct({
	object: Schema.Literal("dashboard_import"),
	dashboard: V2DashboardMutation,
	warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "DashboardPersesImport", title: "Perses dashboard import" })

/**
 * A dashboard's share link, as its owner sees it.
 *
 * Carries the raw `token` on every response, not only the one that mints it:
 * a caller who can read this can already rotate the link, so withholding the
 * token bought no safety and meant you had to break a live link to see it.
 */
export const V2DashboardShare = Schema.Struct({
	id: DashboardSharePublicId,
	object: Schema.Literal("dashboard_share"),
	dashboardId: DashboardPublicId,
	/**
	 * Absent = the whole dashboard. Present = this one widget, and only this one:
	 * a chart link refuses every other widget on the same board.
	 */
	widgetId: optional(Schema.String),
	mode: DashboardShareMode,
	/** The link's credential. The viewer URL is `/share/<token>`. */
	token: Schema.String,
	/** Trailing characters of `token`, for naming a link compactly. */
	tokenSuffix: Schema.String,
	createdAt: Timestamp,
	updatedAt: Timestamp,
})
	.pipe(
		Schema.encodeKeys({
			dashboardId: "dashboard_id",
			widgetId: "widget_id",
			tokenSuffix: "token_suffix",
			createdAt: "created_at",
			updatedAt: "updated_at",
		}),
	)
	.annotate({
		identifier: "DashboardShare",
		title: "Dashboard share link",
		description:
			"A share link for a dashboard, including its `token`. `mode` is `public` (anyone with the link) or `org` (signed-in members of the owning organization).",
	})
export type V2DashboardShare = Schema.Schema.Type<typeof V2DashboardShare>

export const V2DashboardShareParams = Schema.Struct({
	mode: DashboardShareMode,
}).annotate({ identifier: "DashboardShareParams", title: "Dashboard share parameters" })
export type V2DashboardShareParams = Schema.Schema.Type<typeof V2DashboardShareParams>

export const V2DashboardShareDeleteResponse = Schema.Struct({
	dashboardId: DashboardPublicId,
	object: Schema.Literal("dashboard_share"),
	deleted: Schema.Literal(true),
})
	.pipe(Schema.encodeKeys({ dashboardId: "dashboard_id" }))
	.annotate({
		identifier: "DashboardShareDeleted",
		title: "Revoked dashboard share",
		description:
			"Returned whether or not a live share existed — revoking an unshared dashboard is a no-op, not an error.",
	})
export type V2DashboardShareDeleteResponse = Schema.Schema.Type<typeof V2DashboardShareDeleteResponse>

/** Widgets per `widget_data` call; the same per-request cost cap as the share page. */
export const DASHBOARD_WIDGET_DATA_BATCH_MAX = SHARE_WIDGET_BATCH_MAX

export const V2DashboardWidgetDataRequest = Schema.Struct({
	widget_id: Schema.String,
	// `sparkline` reads the tile's sparkline data source instead of its own.
	source: optional(Schema.Literals(["primary", "sparkline"])),
	// The tile's rendered width in points; picks the auto bucket of a timeseries tile.
	max_data_points: optional(Schema.Int.check(Schema.isGreaterThan(0))),
}).annotate({ identifier: "DashboardWidgetDataRequest", title: "Dashboard widget data request" })

export const V2DashboardWidgetDataParams = Schema.Struct({
	requests: Schema.Array(V2DashboardWidgetDataRequest).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(DASHBOARD_WIDGET_DATA_BATCH_MAX),
	),
	time_range: V2TimeRange,
	// Selected values by variable name, checked against the board's own definitions.
	variable_values: optional(StringRecord),
}).annotate({
	identifier: "DashboardWidgetDataParams",
	title: "Dashboard widget data parameters",
	parseOptions: { reportInput: true },
})
export type V2DashboardWidgetDataParams = Schema.Schema.Type<typeof V2DashboardWidgetDataParams>

export const V2DashboardWidgetDataOutcome = Schema.Struct({
	widget_id: Schema.String,
	ok: Schema.Boolean,
	// Present when `ok`: the rows the web dashboard renders, `null` for a static tile.
	data: optional(WireValue),
	// Set when the server narrowed the window for a list-shaped tile.
	narrowed_to_seconds: optional(Schema.Number),
	// Present when not `ok`. `unsupported` is a muted tile; `failed` is retryable.
	reason: optional(Schema.Literals(["unsupported", "not_found", "failed"])),
	message: optional(Schema.String),
}).annotate({
	identifier: "DashboardWidgetDataOutcome",
	title: "Dashboard widget data outcome",
	description:
		"One widget's result. A widget that cannot be served fails inside the 200 so its neighbours still render.",
})
export type V2DashboardWidgetDataOutcome = Schema.Schema.Type<typeof V2DashboardWidgetDataOutcome>

export const V2DashboardWidgetData = Schema.Struct({
	object: Schema.Literal("dashboard_widget_data"),
	results: Schema.Array(V2DashboardWidgetDataOutcome),
	// The value each dashboard variable resolved to, `$__all` for All.
	variables: StringRecord,
}).annotate({
	identifier: "DashboardWidgetData",
	title: "Dashboard widget data",
	description: "Per-widget data for one batch, in request order, plus the resolved variable values.",
})
export type V2DashboardWidgetData = Schema.Schema.Type<typeof V2DashboardWidgetData>

const DashboardList = ListOf(V2Dashboard).annotate({ identifier: "DashboardList" })
const DashboardVersionList = ListOf(V2DashboardVersion).annotate({ identifier: "DashboardVersionList" })
const DashboardTemplateList = ListOf(V2DashboardTemplate).annotate({ identifier: "DashboardTemplateList" })

const [
	dashboardVersionNotFound,
	dashboardPersistence,
	dashboardNotFound,
	dashboardValidation,
	dashboardConcurrency,
	dashboardTemplateNotFound,
	dashboardStoredConfigInvalid,
	sharePersistence,
	shareNotConfigured,
	shareNotFound,
	shareWidgetNotFound,
] = publicErrors(
	DashboardVersionNotFoundError,
	DashboardPersistenceError,
	DashboardNotFoundError,
	DashboardValidationError,
	DashboardConcurrencyError,
	DashboardTemplateNotFoundError,
	DashboardStoredConfigInvalidError,
	SharePersistenceError,
	ShareNotConfiguredError,
	ShareNotFoundError,
	ShareWidgetNotFoundError,
)

const dashboardCreateErrors = [dashboardValidation, dashboardPersistence] as const
const dashboardUpdateErrors = [
	dashboardValidation,
	dashboardPersistence,
	dashboardConcurrency,
	dashboardStoredConfigInvalid,
] as const

export class V2DashboardsApiGroup extends HttpApiGroup.make("dashboards")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: DashboardList,
			error: [V2ParameterInvalid.schema, dashboardPersistence, dashboardStoredConfigInvalid],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listDashboards",
				summary: "List dashboards",
				description: "Returns a cursor-paginated list of dashboards, most recently updated first.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2DashboardCreateParams,
			success: V2DashboardMutation,
			error: dashboardCreateErrors,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createDashboard",
				summary: "Create a dashboard",
				description:
					"Creates a dashboard and returns the committed object, with optional ElectricSQL reconciliation metadata when available.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("importPerses", "/import/perses", {
			payload: V2DashboardPersesImportParams,
			success: V2DashboardPersesImportResponse,
			error: dashboardCreateErrors,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "importPersesDashboard",
				summary: "Import a Perses dashboard",
				description:
					"Converts a Perses dashboard into Maple's dashboard model and returns any conversion warnings.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("listTemplates", "/templates", {
			query: ListQuery,
			success: DashboardTemplateList,
			error: V2ParameterInvalid.schema,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listDashboardTemplates",
				summary: "List dashboard templates",
				description:
					"Returns the built-in dashboard templates in the standard cursor-paginated list envelope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("previewTemplate", "/templates/:template_id/preview", {
			params: { template_id: DashboardTemplatePublicId },
			payload: V2DashboardTemplatePreviewParams,
			success: V2DashboardTemplatePreview,
			error: [V2ParameterInvalid.schema, dashboardTemplateNotFound],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "previewDashboardTemplate",
				summary: "Preview a dashboard template",
				description:
					"Builds the template for the given parameters and returns the resulting dashboard without saving it. Read-only — use `instantiate` to create the dashboard.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("instantiateTemplate", "/templates/:template_id/instantiate", {
			params: { template_id: DashboardTemplatePublicId },
			payload: V2DashboardTemplateInstantiateParams,
			success: V2DashboardMutation,
			error: [
				V2ParameterInvalid.schema,
				V2ParameterMissing.schema,
				dashboardTemplateNotFound,
				...dashboardCreateErrors,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "instantiateDashboardTemplate",
				summary: "Instantiate a dashboard template",
				description:
					"Builds and persists a new dashboard from a template and its required parameters.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: DashboardPublicId },
			success: V2Dashboard,
			error: [dashboardPersistence, dashboardNotFound, dashboardStoredConfigInvalid],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getDashboard",
				summary: "Retrieve a dashboard",
				description: "Returns a complete dashboard definition by its opaque `dash_` public ID.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("widgetData", "/:id/widget_data", {
			params: { id: DashboardPublicId },
			payload: V2DashboardWidgetDataParams,
			success: V2DashboardWidgetData,
			error: [
				V2TimeRangeInvalid.schema,
				V2ParameterInvalid.schema,
				dashboardPersistence,
				dashboardNotFound,
				dashboardStoredConfigInvalid,
			],
		})
			.annotate(AuditedRead, "telemetry.read")
			.annotateMerge(
				OpenApi.annotations({
					identifier: "queryDashboardWidgetData",
					summary: "Query dashboard widget data",
					description: `Evaluates up to ${DASHBOARD_WIDGET_DATA_BATCH_MAX} widgets of a saved dashboard over a time range, from the stored widget definitions, exactly as the dashboard renders them. Read-only; requires \`dashboards:read\`.`,
				}),
			),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: DashboardPublicId },
			payload: V2DashboardUpdateParams,
			success: V2DashboardMutation,
			error: [dashboardNotFound, ...dashboardUpdateErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateDashboard",
				summary: "Update a dashboard",
				description: "Applies a partial JSON update; omitted fields retain their current values.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: DashboardPublicId },
			success: V2DashboardDeleteResponse,
			error: [dashboardPersistence, dashboardNotFound],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteDashboard",
				summary: "Delete a dashboard",
				description:
					"Permanently deletes a dashboard and returns a tombstone, with optional ElectricSQL reconciliation metadata when available.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("listVersions", "/:id/versions", {
			params: { id: DashboardPublicId },
			query: ListQuery,
			success: DashboardVersionList,
			error: [
				V2ParameterInvalid.schema,
				dashboardPersistence,
				dashboardNotFound,
				dashboardStoredConfigInvalid,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listDashboardVersions",
				summary: "List dashboard versions",
				description: "Returns a newest-first, cursor-paginated audit history for a dashboard.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieveVersion", "/:id/versions/:version_id", {
			params: { id: DashboardPublicId, version_id: DashboardVersionPublicId },
			success: V2DashboardVersionDetail,
			error: [
				dashboardPersistence,
				dashboardNotFound,
				dashboardVersionNotFound,
				dashboardStoredConfigInvalid,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getDashboardVersion",
				summary: "Retrieve a dashboard version",
				description: "Returns one dashboard version together with its complete immutable snapshot.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("restoreVersion", "/:id/versions/:version_id/restore", {
			params: { id: DashboardPublicId, version_id: DashboardVersionPublicId },
			success: V2DashboardMutation,
			error: [dashboardNotFound, dashboardVersionNotFound, ...dashboardUpdateErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "restoreDashboardVersion",
				summary: "Restore a dashboard version",
				description: "Restores a historical snapshot as the dashboard's new current version.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("listShares", "/:id/shares", {
			params: { id: DashboardPublicId },
			success: Schema.Array(V2DashboardShare),
			error: [sharePersistence, dashboardPersistence, dashboardNotFound, dashboardStoredConfigInvalid],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listDashboardShares",
				summary: "List a dashboard's share links",
				description:
					"Returns every live share on the dashboard — the board's own link, plus one per shared widget, each with its token.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieveWidgetShare", "/:id/widgets/:widget_id/share", {
			params: { id: DashboardPublicId, widget_id: Schema.String },
			success: Schema.NullOr(V2DashboardShare),
			error: [sharePersistence, dashboardPersistence, dashboardNotFound, dashboardStoredConfigInvalid],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getDashboardWidgetShare",
				summary: "Retrieve a widget's share link",
				description:
					"Returns the live share link for one widget, or `null` when that widget is not shared.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.put("upsertWidgetShare", "/:id/widgets/:widget_id/share", {
			params: { id: DashboardPublicId, widget_id: Schema.String },
			payload: V2DashboardShareParams,
			success: V2DashboardShare,
			error: [
				V2InsufficientPermissions.schema,
				sharePersistence,
				shareNotConfigured,
				dashboardPersistence,
				dashboardNotFound,
				dashboardStoredConfigInvalid,
				shareWidgetNotFound,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "upsertDashboardWidgetShare",
				summary: "Share a single widget",
				description:
					"Creates a share link scoped to one widget, or changes the mode of the one it already has. The link only resolves while the dashboard itself is shared, and never grants more than the dashboard's own mode: unsharing the board disables it, sharing the board again restores it. A `public` widget share on a `public` dashboard may be embedded in an iframe.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("rotateWidgetShare", "/:id/widgets/:widget_id/share/rotate", {
			params: { id: DashboardPublicId, widget_id: Schema.String },
			success: V2DashboardShare,
			error: [
				V2InsufficientPermissions.schema,
				sharePersistence,
				shareNotConfigured,
				shareNotFound,
				dashboardPersistence,
				dashboardNotFound,
				dashboardStoredConfigInvalid,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "rotateDashboardWidgetShare",
				summary: "Regenerate a widget's share link",
				description:
					"Revokes the widget's current link and mints a replacement. Any embed using the old URL stops rendering immediately.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("revokeWidgetShare", "/:id/widgets/:widget_id/share", {
			params: { id: DashboardPublicId, widget_id: Schema.String },
			success: V2DashboardShareDeleteResponse,
			error: [sharePersistence, dashboardPersistence, dashboardNotFound, dashboardStoredConfigInvalid],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "revokeDashboardWidgetShare",
				summary: "Stop sharing a widget",
				description:
					"Revokes the widget's share link. Idempotent — revoking an unshared widget succeeds and reports `deleted: true`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieveShare", "/:id/share", {
			params: { id: DashboardPublicId },
			success: Schema.NullOr(V2DashboardShare),
			error: [sharePersistence, dashboardPersistence, dashboardNotFound, dashboardStoredConfigInvalid],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getDashboardShare",
				summary: "Retrieve a dashboard's share link",
				description:
					"Returns the dashboard's live share link and its token, or `null` when it is not shared.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.put("upsertShare", "/:id/share", {
			params: { id: DashboardPublicId },
			payload: V2DashboardShareParams,
			success: V2DashboardShare,
			error: [
				V2InsufficientPermissions.schema,
				sharePersistence,
				shareNotConfigured,
				dashboardPersistence,
				dashboardNotFound,
				dashboardStoredConfigInvalid,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "upsertDashboardShare",
				summary: "Share a dashboard",
				description:
					"Creates the dashboard's share link, or changes the mode of the one it already has. Changing the mode keeps the same link, so the returned token is unchanged.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("rotateShare", "/:id/share/rotate", {
			params: { id: DashboardPublicId },
			success: V2DashboardShare,
			error: [
				V2InsufficientPermissions.schema,
				sharePersistence,
				shareNotConfigured,
				shareNotFound,
				dashboardPersistence,
				dashboardNotFound,
				dashboardStoredConfigInvalid,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "rotateDashboardShare",
				summary: "Regenerate a dashboard's share link",
				description:
					"Revokes the current link and mints a replacement in one step. The previous URL stops resolving immediately.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("revokeShare", "/:id/share", {
			params: { id: DashboardPublicId },
			success: V2DashboardShareDeleteResponse,
			error: [sharePersistence, dashboardPersistence, dashboardNotFound, dashboardStoredConfigInvalid],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "revokeDashboardShare",
				summary: "Stop sharing a dashboard",
				description:
					"Revokes the dashboard's share link. Idempotent — revoking an unshared dashboard succeeds and reports `deleted: true`.",
			}),
		),
	)
	.prefix("/v2/dashboards")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Dashboards",
			description:
				"Create and manage dashboards, browse version history, restore snapshots, and instantiate built-in templates.",
		}),
	) {}
