import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, paginateArray, V2InsufficientPermissions } from "@maple/domain/http/v2"
import type { V2DataSourceTestResult, V2DataSourceUpdateParams } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import {
	mapCurationErrors,
	mapListErrors,
	mapReadErrors,
	mapServiceErrors,
	secretChanged,
	toCreateInput,
	toUpdateInput,
	toV2CatalogEntry,
	toV2DataSource,
} from "./data-sources.mapping"

// People reach every source of their org, including ones hidden from agents.
const PEOPLE = { agent: false } as const

/** Update fields, for the audit row's list of what changed. */
const UPDATE_FIELDS = [
	"name",
	"description",
	"environment",
	"tags",
	"agent_access",
	"agent_pii",
	"connection",
] as const satisfies ReadonlyArray<keyof V2DataSourceUpdateParams>

export const HttpV2DataSourcesLive = HttpApiBuilder.group(MapleApiV2, "dataSources", (handlers) =>
	Effect.gen(function* () {
		const service = yield* ExternalDataSourceService

		// Sources hold credentials to the org's own systems: writes, tests and refreshes are admin-only.
		const requireManage = Effect.gen(function* () {
			const tenant = yield* CurrentTenant.Context
			yield* Policy.check(tenant.roles, "data_sources:manage", (denial) =>
				V2InsufficientPermissions.make(denial.message),
			)
			return tenant
		})

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const sources = yield* mapListErrors(service.list(tenant.orgId, PEOPLE))
					const page = yield* paginateArray(Arr.map(sources, toV2DataSource), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const source = yield* mapReadErrors(service.get(tenant.orgId, params.id, PEOPLE))
					return toV2DataSource(source)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const created = yield* mapServiceErrors(
						service.create(tenant.orgId, tenant.userId, toCreateInput(payload)),
					)
					yield* recordHttpAudit("data_source.created", {
						resourceId: created.id,
						metadata: {
							name: created.name,
							kind: created.kind,
							environment: created.environment,
						},
					})
					return { ...toV2DataSource(created), warnings: created.warnings }
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const updated = yield* mapServiceErrors(
						service.update(tenant.orgId, tenant.userId, params.id, toUpdateInput(payload)),
					)
					yield* recordHttpAudit("data_source.updated", {
						resourceId: updated.id,
						metadata: {
							name: updated.name,
							fields: Arr.join(
								Arr.filter(UPDATE_FIELDS, (field) => payload[field] !== undefined),
								",",
							),
							secret_changed: secretChanged(payload),
						},
					})
					return { ...toV2DataSource(updated), warnings: updated.warnings }
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const source = yield* mapReadErrors(service.get(tenant.orgId, params.id, PEOPLE))
					yield* mapReadErrors(service.remove(tenant.orgId, params.id))
					yield* recordHttpAudit("data_source.deleted", {
						resourceId: params.id,
						metadata: { name: source.name, kind: source.kind },
					})
					return { id: params.id, object: "data_source" as const, deleted: true as const }
				}),
			)
			.handle("test", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const result = yield* mapReadErrors(service.test(tenant.orgId, params.id))
					yield* recordHttpAudit("data_source.tested", {
						resourceId: params.id,
						metadata: { ok: result.ok },
					})
					return {
						object: "data_source_test",
						ok: result.ok,
						latency_ms: result.latencyMs,
						warnings: result.warnings,
						error: result.error ?? null,
					} satisfies V2DataSourceTestResult
				}),
			)
			.handle("refreshCatalog", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const refreshed = yield* mapServiceErrors(service.refreshCatalog(tenant.orgId, params.id))
					yield* recordHttpAudit("data_source.catalog_refreshed", {
						resourceId: params.id,
						metadata: { name: refreshed.name, entries: refreshed.catalogEntryCount },
					})
					return toV2DataSource(refreshed)
				}),
			)
			.handle("catalog", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const view = yield* mapReadErrors(service.catalog(tenant.orgId, params.id, PEOPLE))
					return {
						object: "data_source_catalog" as const,
						source_id: view.source.id,
						refreshed_at: toV2DataSource(view.source).catalog_refreshed_at,
						error: view.source.catalogError,
						entries: Arr.map(view.entries, toV2CatalogEntry),
					}
				}),
			)
			.handle("updateCatalogEntry", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const entry = yield* mapCurationErrors(
						service.updateCatalogEntry(tenant.orgId, params.id, params.entry, {
							...(payload.exposed === undefined ? undefined : { exposed: payload.exposed }),
							...(payload.note === undefined ? undefined : { note: payload.note }),
							...(payload.time_field === undefined
								? undefined
								: { timeField: payload.time_field }),
							...(payload.field_notes === undefined
								? undefined
								: { fieldNotes: payload.field_notes }),
						}),
					)
					yield* recordHttpAudit("data_source.catalog_curated", {
						resourceId: params.id,
						metadata: { entry: entry.name, exposed: entry.exposed },
					})
					return toV2CatalogEntry(entry)
				}),
			)
	}),
)
