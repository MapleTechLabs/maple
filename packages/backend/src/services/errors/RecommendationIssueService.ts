import { randomUUID } from "node:crypto"
import {
	IsoDateTimeString,
	OrgId,
	RecommendationIssue,
	RecommendationIssueId,
	RecommendationIssueKind,
	RecommendationIssueNotFoundError,
	RecommendationIssuePersistenceError,
	RecommendationIssuesListResponse,
	RecommendationIssueStatus,
} from "@maple/domain/http"
import { detectAttributeRecommendations, planReconcileIssues } from "@maple/domain/recommendations"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	OrgIngestAttributeMappings,
	OrgRecommendationIssues,
	type OrgRecommendationIssueInsert,
	type OrgRecommendationIssueRow,
} from "@maple/db/tables"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

type IssueRow = OrgRecommendationIssueRow

export interface RecommendationIssueServiceApi {
	/** Reconciles live telemetry → persisted issues, then returns the full numbered list. */
	readonly listReconciled: (
		tenant: TenantContext,
	) => Effect.Effect<RecommendationIssuesListResponse, RecommendationIssuePersistenceError>
	readonly dismiss: (
		tenant: TenantContext,
		id: RecommendationIssueId,
	) => Effect.Effect<
		RecommendationIssuesListResponse,
		RecommendationIssueNotFoundError | RecommendationIssuePersistenceError
	>
	readonly reopen: (
		tenant: TenantContext,
		id: RecommendationIssueId,
	) => Effect.Effect<
		RecommendationIssuesListResponse,
		RecommendationIssueNotFoundError | RecommendationIssuePersistenceError
	>
}

const decodeIssueIdSync = Schema.decodeUnknownSync(RecommendationIssueId)
const decodeKindSync = Schema.decodeUnknownSync(RecommendationIssueKind)
const decodeStatusSync = Schema.decodeUnknownSync(RecommendationIssueStatus)
const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)

const toPersistenceError = (error: DatabaseError) =>
	new RecommendationIssuePersistenceError({ message: error.message })

const rowToIssue = (row: IssueRow): RecommendationIssue =>
	new RecommendationIssue({
		id: decodeIssueIdSync(row.id),
		number: row.number,
		recommendationKey: row.recommendationKey,
		kind: decodeKindSync(row.kind),
		sourceKey: row.sourceKey,
		...(row.canonicalKey != null ? { canonicalKey: row.canonicalKey } : undefined),
		status: decodeStatusSync(row.status),
		usageCount: row.usageCount,
		openedAt: decodeIsoSync(new Date(row.openedAt).toISOString()),
		updatedAt: decodeIsoSync(new Date(row.updatedAt).toISOString()),
		...(row.resolvedAt != null
			? { resolvedAt: decodeIsoSync(new Date(row.resolvedAt).toISOString()) }
			: undefined),
	})

export class RecommendationIssueService extends Context.Service<
	RecommendationIssueService,
	RecommendationIssueServiceApi
>()("@maple/api/services/RecommendationIssueService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService

		const dbExecute = makeDbExecute(database, "RecommendationIssueService", toPersistenceError)

		const selectAll = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(OrgRecommendationIssues)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.orderBy(["number", "asc"]),
				),
			)

		const listResponse = (orgId: OrgId) =>
			selectAll(orgId).pipe(
				Effect.map((rows) => new RecommendationIssuesListResponse({ issues: rows.map(rowToIssue) })),
			)

		// Reads the org's live span attribute keys (last 24h) from the warehouse.
		const fetchSpanKeys = Effect.fn("RecommendationIssueService.fetchSpanKeys")(function* (
			tenant: TenantContext,
		) {
			const now = yield* Clock.currentTimeMillis
			const compiled = CH.compile(CH.attributeKeysQuery({ scope: "span" }), {
				orgId: tenant.orgId,
				startTime: formatWarehouseDateTime(now - 24 * 60 * 60 * 1000),
				endTime: formatWarehouseDateTime(now),
			})
			const rows = yield* warehouse
				.compiledQuery(tenant, compiled, { profile: "discovery", context: "recommendationIssues" })
				.pipe(
					Effect.tapCause((cause) =>
						Effect.logError("Recommendation span-key query failed").pipe(
							Effect.annotateLogs({ cause }),
						),
					),
					Effect.mapError(
						() =>
							new RecommendationIssuePersistenceError({
								message: "Failed to read span attribute keys",
							}),
					),
				)
			return rows.map((row) => ({
				attributeKey: row.attributeKey,
				usageCount: row.usageCount,
			}))
		})

		const listReconciled = Effect.fn("RecommendationIssueService.listReconciled")(function* (
			tenant: TenantContext,
		) {
			const orgId = tenant.orgId
			yield* Effect.annotateCurrentSpan("orgId", orgId)

			// Reconcile needs live span keys. If the warehouse is unavailable, degrade gracefully:
			// return the stored issues unchanged rather than failing the whole settings page.
			const spanKeysOpt = yield* fetchSpanKeys(tenant).pipe(Effect.option)
			if (Option.isNone(spanKeysOpt)) {
				yield* Effect.logWarning(
					"Recommendation reconcile skipped — warehouse unavailable; returning stored issues",
				)
				return yield* listResponse(orgId)
			}
			const spanKeys = spanKeysOpt.value

			const mappingRows = yield* dbExecute((db) =>
				db.run(
					PG.from(OrgIngestAttributeMappings)
						.select("sourceKey")
						.where(($) => [$.orgId.eq(orgId), $.sourceContext.eq("span")]),
				),
			)
			const mappingSourceKeys = mappingRows.map((row) => row.sourceKey)

			const detected = detectAttributeRecommendations(spanKeys, mappingSourceKeys)
			const existing = yield* selectAll(orgId)
			const existingLike = existing.map((row) => ({
				id: row.id,
				number: row.number,
				recommendationKey: row.recommendationKey,
				sourceKey: row.sourceKey,
				status: decodeStatusSync(row.status),
			}))
			const plan = planReconcileIssues(detected, existingLike, mappingSourceKeys)

			const now = yield* Clock.currentTimeMillis

			if (plan.inserts.length > 0) {
				const rows = plan.inserts.map((insert) => ({
					id: decodeIssueIdSync(randomUUID()),
					orgId,
					number: insert.number,
					recommendationKey: insert.recommendationKey,
					kind: insert.kind,
					sourceKey: insert.sourceKey,
					canonicalKey: insert.canonicalKey ?? null,
					status: "open",
					usageCount: insert.usageCount,
					openedAt: now,
					updatedAt: now,
					resolvedAt: null,
				}))
				yield* dbExecute((db) => db.run(PG.insertInto(OrgRecommendationIssues).values(rows)))
			}

			yield* Effect.forEach(
				plan.updates,
				(update) => {
					const fields: Partial<OrgRecommendationIssueInsert> = {
						updatedAt: now,
						...(update.usageCount !== undefined ? { usageCount: update.usageCount } : undefined),
						...(update.nextStatus !== undefined
							? {
									status: update.nextStatus,
									resolvedAt: update.nextStatus === "open" ? null : now,
								}
							: undefined),
					}
					return dbExecute((db) =>
						db.run(
							PG.update(OrgRecommendationIssues)
								.set(fields)
								.where(($) => [$.orgId.eq(orgId), $.id.eq(update.id)]),
						),
					)
				},
				{ discard: true },
			)

			return yield* listResponse(orgId)
		})

		const setStatus = Effect.fn("RecommendationIssueService.setStatus")(function* (
			tenant: TenantContext,
			id: RecommendationIssueId,
			fields: Partial<OrgRecommendationIssueInsert>,
		) {
			const orgId = tenant.orgId
			yield* Effect.annotateCurrentSpan({ orgId, "maple.recommendation_issue.id": id })
			const existing = yield* dbExecute((db) =>
				db.run(
					PG.from(OrgRecommendationIssues)
						.select("id")
						.where(($) => [$.orgId.eq(orgId), $.id.eq(id)])
						.limit(1),
				),
			)
			if (Option.isNone(Option.fromNullishOr(existing[0]))) {
				yield* Effect.logWarning("Recommendation issue not found").pipe(
					Effect.annotateLogs({ issueId: id, orgId }),
				)
				return yield* new RecommendationIssueNotFoundError({
					id,
					message: "Recommendation not found",
				})
			}

			const now = yield* Clock.currentTimeMillis
			yield* dbExecute((db) =>
				db.run(
					PG.update(OrgRecommendationIssues)
						.set({ ...fields, updatedAt: now })
						.where(($) => [$.orgId.eq(orgId), $.id.eq(id)]),
				),
			)
			return yield* listResponse(orgId)
		})

		const dismiss = (tenant: TenantContext, id: RecommendationIssueId) =>
			setStatus(tenant, id, { status: "dismissed" })

		const reopen = (tenant: TenantContext, id: RecommendationIssueId) =>
			setStatus(tenant, id, { status: "open", resolvedAt: null })

		return { listReconciled, dismiss, reopen } satisfies RecommendationIssueServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
