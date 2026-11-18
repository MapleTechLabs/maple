/**
 * Google Cloud cost sources: a Cloud Billing export to BigQuery, read as the reader account of one
 * of the org's GCP connectors. Adding one saves the export and its `cost_sources` row together;
 * the API holds no Google identity, so the first sync, minutes later, says whether the reader can
 * query the table.
 */
import {
	type GcpCostConnector,
	type GcpCostExport,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
	type OrgId,
} from "@maple/domain/http"
import { gcpConnectorResourceNames, gcpServiceAccountEmail } from "@maple/domain/gcp"
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSources, GcpConnectors, GcpCostExports } from "@maple/db/tables"
import { CostSourceId, type GcpConnectorId, type UserId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { parseExportTable } from "./providers/gcp/bigquery"

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"GCP cost source database error",
)

/** An org has a handful of connectors and exports; these bound what one status read lists. */
const MAX_LISTED = 100

const exportOf = (row: {
	readonly id: string
	readonly connectorId: GcpConnectorId
	readonly tableRef: string
	readonly billingAccountId: string
}): GcpCostExport => ({
	id: row.id,
	connectorId: row.connectorId,
	tableRef: row.tableRef,
	billingAccountId: row.billingAccountId,
	detailed: Option.match(parseExportTable(row.tableRef), {
		onNone: () => false,
		onSome: (table) => table.detailed,
	}),
})

export interface GcpCostSourceServiceApi {
	readonly status: (orgId: OrgId) => Effect.Effect<
		{
			readonly connectors: ReadonlyArray<GcpCostConnector>
			readonly exports: ReadonlyArray<GcpCostExport>
		},
		IntegrationsPersistenceError
	>
	/** `created` is false when the org reads that table already. */
	readonly add: (
		orgId: OrgId,
		userId: UserId,
		connectorId: GcpConnectorId,
		tableRef: string,
	) => Effect.Effect<
		{ readonly export: GcpCostExport; readonly created: boolean },
		IntegrationsNotConnectedError | IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly remove: (
		orgId: OrgId,
		exportId: string,
	) => Effect.Effect<{ readonly removed: boolean }, IntegrationsPersistenceError>
}

export class GcpCostSourceService extends Context.Service<GcpCostSourceService, GcpCostSourceServiceApi>()(
	"@maple/backend/services/cost/GcpCostSourceService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "GcpCostSourceService", toPersistenceError)

			const status = Effect.fn("GcpCostSourceService.status")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const [connectors, exports] = yield* dbExecute((db) =>
					Effect.all([
						db.run(
							PG.from(GcpConnectors)
								.select(
									"id",
									"scopeType",
									"scopeId",
									"projectId",
									"metricsEnabled",
									"createdAt",
								)
								.where(($) => [$.orgId.eq(orgId)])
								.orderBy(["createdAt", "asc"])
								.limit(MAX_LISTED),
						),
						db.run(
							PG.from(GcpCostExports)
								.select("id", "connectorId", "tableRef", "billingAccountId", "createdAt")
								.where(($) => [$.orgId.eq(orgId)])
								.orderBy(["createdAt", "asc"])
								.limit(MAX_LISTED),
						),
					]),
				)
				return {
					connectors: Arr.map(connectors, (connector) => ({
						id: connector.id,
						scopeType: connector.scopeType,
						scopeId: connector.scopeId,
						projectId: connector.projectId,
						metricsEnabled: connector.metricsEnabled,
						readerEmail: gcpServiceAccountEmail(
							gcpConnectorResourceNames(connector.id).serviceAccountId,
							connector.projectId,
						),
					})),
					exports: Arr.map(exports, exportOf),
				}
			})

			const add = Effect.fn("GcpCostSourceService.add")(function* (
				orgId: OrgId,
				userId: UserId,
				connectorId: GcpConnectorId,
				tableRef: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const table = parseExportTable(tableRef)
				if (Option.isNone(table)) {
					return yield* new IntegrationsValidationError({
						message:
							"That is not a Cloud Billing export table. Copy its id from BigQuery: project.dataset.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX.",
					})
				}
				const now = yield* Clock.currentTimeMillis
				const result = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// The share lock makes a connector deleted meanwhile wait for, then cascade over, the insert.
							const [connector] = yield* db.run(
								PG.from(GcpConnectors)
									.select("id", "metricsEnabled")
									.where(($) => [$.orgId.eq(orgId), $.id.eq(connectorId)])
									.limit(1)
									.forShare(),
							)
							if (connector === undefined) return { kind: "no_connector" } as const
							if (!connector.metricsEnabled) return { kind: "no_reader" } as const
							const id = randomUUID()
							const inserted = yield* db.run(
								PG.insertInto(GcpCostExports)
									.values({
										id,
										orgId,
										connectorId,
										tableRef: table.value.ref,
										billingAccountId: table.value.billingAccountId,
										createdBy: userId,
										createdAt: now,
										updatedAt: now,
									})
									.onConflictDoNothing()
									.returning(($) => ({ id: $.id })),
							)
							// One export per billing account: a second table of it would count its spend twice.
							if (inserted.length === 0) {
								const [existing] = yield* db.run(
									PG.from(GcpCostExports)
										.select("id", "connectorId", "tableRef", "billingAccountId")
										.where(($) => [
											$.orgId.eq(orgId),
											$.billingAccountId.eq(table.value.billingAccountId),
										])
										.limit(1),
								)
								return existing === undefined
									? ({ kind: "no_connector" } as const)
									: existing.tableRef === table.value.ref
										? ({ kind: "exists", row: existing } as const)
										: ({ kind: "other_table", tableRef: existing.tableRef } as const)
							}
							yield* db.run(
								PG.insertInto(CostSources).values({
									id: CostSourceId.make(randomUUID()),
									orgId,
									provider: "gcp",
									connectionRef: id,
									accountId: table.value.billingAccountId,
									createdAt: now,
									updatedAt: now,
								}),
							)
							return {
								kind: "created",
								row: {
									id,
									connectorId,
									tableRef: table.value.ref,
									billingAccountId: table.value.billingAccountId,
								},
							} as const
						}),
					),
				)
				switch (result.kind) {
					case "no_connector":
						return yield* new IntegrationsNotConnectedError({
							message:
								"That GCP connection is gone. Pick another, or connect Google Cloud first.",
						})
					case "no_reader":
						return yield* new IntegrationsValidationError({
							message:
								"Turn on Metrics and resources for that GCP connection first: Maple reads the export as its reader account.",
						})
					case "other_table":
						return yield* new IntegrationsValidationError({
							message: `Maple already reads billing account ${table.value.billingAccountId} from ${result.tableRef}. Remove that source first to read it from another table.`,
						})
					case "exists":
						return { export: exportOf(result.row), created: false }
					case "created":
						return { export: exportOf(result.row), created: true }
				}
			})

			const remove = Effect.fn("GcpCostSourceService.remove")(function* (
				orgId: OrgId,
				exportId: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const removed = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.deleteFrom(CostSources).where(($) => [
									$.orgId.eq(orgId),
									$.provider.eq("gcp"),
									$.connectionRef.eq(exportId),
								]),
							)
							return yield* db.run(
								PG.deleteFrom(GcpCostExports)
									.where(($) => [$.orgId.eq(orgId), $.id.eq(exportId)])
									.returning(($) => ({ id: $.id })),
							)
						}),
					),
				)
				return { removed: removed.length > 0 }
			})

			return { status, add, remove } satisfies GcpCostSourceServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
