import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	DataSourceCatalogEntryNotFoundError,
	DataSourceInvalidError,
	DataSourceNotFoundHttpError,
	DataSourceRateLimitedHttpError,
	DataSourceStorageUnavailableError,
	DataSourceUnreachableError,
} from "../data-sources-errors"
import { AuthorizationV2 } from "./auth"
import {
	DataSourcePublicId,
	V2CatalogEntry,
	V2CatalogEntryUpdateParams,
	V2DataSource,
	V2DataSourceCatalog,
	V2DataSourceCreateParams,
	V2DataSourceDeleteResponse,
	V2DataSourceTestResult,
	V2DataSourceUpdateParams,
} from "./data-sources-wire"
import { ListOf, ListQuery } from "./envelopes"
import { V2InsufficientPermissions, V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"

export * from "./data-sources-wire"

const [notFound, entryNotFound, invalid, unreachable, rateLimited, storage] = publicErrors(
	DataSourceNotFoundHttpError,
	DataSourceCatalogEntryNotFoundError,
	DataSourceInvalidError,
	DataSourceUnreachableError,
	DataSourceRateLimitedHttpError,
	DataSourceStorageUnavailableError,
)
const forbidden = V2InsufficientPermissions.schema

const DataSourceList = ListOf(V2DataSource).annotate({
	identifier: "DataSourceList",
	title: "Data source list",
	description: "A cursor-paginated page of data sources.",
})

const idParams = { id: DataSourcePublicId }

const doc = (identifier: string, summary: string, description: string) =>
	OpenApi.annotations({ identifier, summary, description })

export class V2DataSourcesApiGroup extends HttpApiGroup.make("dataSources")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: DataSourceList,
			error: [V2ParameterInvalid.schema, storage],
		}).annotateMerge(
			doc("listDataSources", "List data sources", "Returns the organization's data sources by name. Any member may call it. Requires `data_sources:read`."),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2DataSourceCreateParams,
			success: V2DataSource,
			error: [forbidden, notFound, invalid, unreachable, rateLimited, storage],
		}).annotateMerge(
			doc(
				"createDataSource",
				"Connect a data source",
				"Tests the connection first and saves nothing when it fails, then reads the source's catalog. Requires an org-admin role and `data_sources:write`.",
			),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: idParams,
			success: V2DataSource,
			error: [notFound, storage],
		}).annotateMerge(doc("getDataSource", "Retrieve a data source", "Requires `data_sources:read`.")),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: idParams,
			payload: V2DataSourceUpdateParams,
			success: V2DataSource,
			error: [forbidden, notFound, invalid, unreachable, rateLimited, storage],
		}).annotateMerge(
			doc(
				"updateDataSource",
				"Update a data source",
				"Omitted fields are unchanged. A new `connection` is tested before it is saved; omit its password or key to keep the stored one. Requires an org-admin role and `data_sources:write`.",
			),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: idParams,
			success: V2DataSourceDeleteResponse,
			error: [forbidden, notFound, storage],
		}).annotateMerge(
			doc("deleteDataSource", "Delete a data source", "Removes the source, its stored secret and its catalog. Requires an org-admin role and `data_sources:write`."),
		),
	)
	.add(
		HttpApiEndpoint.post("test", "/:id/test", {
			params: idParams,
			success: V2DataSourceTestResult,
			error: [forbidden, notFound, storage],
		}).annotateMerge(
			doc("testDataSource", "Test a data source", "Reaches the source with the stored credentials and records the outcome. A failed test is a result with `ok: false`. Requires an org-admin role and `data_sources:write`."),
		),
	)
	.add(
		HttpApiEndpoint.post("refreshCatalog", "/:id/catalog/refresh", {
			params: idParams,
			success: V2DataSource,
			error: [forbidden, notFound, invalid, unreachable, rateLimited, storage],
		}).annotateMerge(
			doc("refreshDataSourceCatalog", "Refresh a data source's catalog", "Reads the source's tables or resources again. Curation (exposed entries, notes, time fields) is kept. Requires an org-admin role and `data_sources:write`."),
		),
	)
	.add(
		HttpApiEndpoint.get("catalog", "/:id/catalog", {
			params: idParams,
			success: V2DataSourceCatalog,
			error: [notFound, storage],
		}).annotateMerge(
			doc("getDataSourceCatalog", "Retrieve a data source's catalog", "Every stored entry with curation applied, hidden ones included. Requires `data_sources:read`."),
		),
	)
	.add(
		HttpApiEndpoint.patch("updateCatalogEntry", "/:id/catalog/entries/:entry", {
			params: { id: DataSourcePublicId, entry: Schema.String },
			payload: V2CatalogEntryUpdateParams,
			success: V2CatalogEntry,
			error: [forbidden, notFound, entryNotFound, invalid, storage],
		}).annotateMerge(
			doc("updateDataSourceCatalogEntry", "Curate a catalog entry", "Expose or hide an entry from agents, and set its note, time field and field notes. Survives catalog refreshes. Requires an org-admin role and `data_sources:write`."),
		),
	)
	.prefix("/v2/data_sources")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Data Sources",
			description:
				"Databases and APIs your organization connects so Maple and its agents can query them in place. Nothing is imported. Members can read sources and catalogs; connecting, editing, testing and curating take an admin.",
		}),
	) {}
