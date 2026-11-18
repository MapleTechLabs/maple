import { HttpApiBuilder } from "effect/http-api"
import type { ScrapeTargetResponse } from "@maple/domain/http"
import {
	CreateScrapeTargetRequest,
	CurrentTenant,
	SCRAPE_TARGET_REDACTED_VALUE,
	UpdateScrapeTargetRequest,
} from "@maple/domain/http"
import {
	MapleApiV2,
	paginateArray,
	paginateOffsetQuery,
	scopeAllows,
	timestamp,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import { redactUrlCredentials } from "@maple/domain/url-redaction"
import type { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { Effect, Array as Arr } from "effect"
import { auditDiff, redactAuditUrl } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import * as Policy from "@maple/domain/policy"
import { timestampMs } from "@maple/backend/platform/time"

// Every write needs scrape_targets:manage: a scrape target stores credentials and makes
// Maple's infrastructure fetch an operator-chosen URL, so `probe` (which sends
// the stored credential on demand) is a write, not a read. Reads stay on the
// `scrape_targets:read` scope — they never expose the credential itself.

/** Whether the caller may manage scrape targets: the role, and for a scoped API key the write scope too. */
const canManageTargets = (tenant: CurrentTenant.TenantContext) =>
	Policy.can(tenant.roles, "scrape_targets:manage") &&
	scopeAllows(tenant.scopes, { family: "scrape_targets", access: "write" })

/**
 * Callers who cannot manage targets read the URL without its userinfo and query values. The path
 * is shown to them, as it is in the audit log: a token belongs in the query or the credentials.
 */
const forReader = (target: V2ScrapeTarget, canManage: boolean): V2ScrapeTarget =>
	canManage ? target : { ...target, url: redactUrlCredentials(target.url, SCRAPE_TARGET_REDACTED_VALUE) }

const toV2ScrapeTarget = (target: ScrapeTargetResponse): V2ScrapeTarget => ({
	id: target.id,
	object: "scrape_target",
	name: target.name,
	service_name: target.serviceName,
	url: target.url,
	target_type: target.targetType,
	organization: target.organization,
	include_branches: target.includeBranches,
	exclude_branches: target.excludeBranches,
	scrape_interval_seconds: target.scrapeIntervalSeconds,
	labels_json: target.labelsJson,
	auth_type: target.authType,
	has_credentials: target.hasCredentials,
	managed_by: target.managedBy,
	enabled: target.enabled,
	last_scrape_at: target.lastScrapeAt,
	last_scrape_error: target.lastScrapeError,
	created_at: target.createdAt,
	updated_at: target.updatedAt,
})

/** Update-payload fields diffable through the wire shape; credentials never appear. */
const targetAuditDiff = auditDiff({
	fields: [
		"name",
		"url",
		"organization",
		"include_branches",
		"exclude_branches",
		"scrape_interval_seconds",
		"labels_json",
		"auth_type",
		"service_name",
		"enabled",
	],
	// Scrape URLs may carry tokens in userinfo/query — audit only scheme/host/path.
	// Identical redacted values still mean the URL changed within the stripped part.
	redact: { url: redactAuditUrl },
	// Credentials are write-only: audit that they rotated, never their value.
	writeOnly: ["auth_credentials"],
})

export const HttpV2ScrapeTargetsLive = HttpApiBuilder.group(MapleApiV2, "scrapeTargets", (handlers) =>
	Effect.gen(function* () {
		const service = yield* ScrapeTargetsService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* service.list(tenant.orgId)
					const canManage = canManageTargets(tenant)
					const page = yield* paginateArray(
						Arr.map(response.targets, (target) => forReader(toV2ScrapeTarget(target), canManage)),
						query,
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const target = yield* service.get(tenant.orgId, params.id)

					return forReader(toV2ScrapeTarget(target), canManageTargets(tenant))
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Policy.check(tenant.roles, "scrape_targets:manage", (denial) =>
						V2InsufficientPermissions.make(denial.message),
					)
					const created = yield* service.create(
						tenant.orgId,
						new CreateScrapeTargetRequest({
							name: payload.name,
							...(payload.url !== undefined ? { url: payload.url } : undefined),
							...(payload.target_type !== undefined
								? { targetType: payload.target_type }
								: undefined),
							...(payload.organization !== undefined
								? { organization: payload.organization }
								: undefined),
							...(payload.include_branches !== undefined
								? {
										includeBranches: payload.include_branches,
									}
								: undefined),
							...(payload.exclude_branches !== undefined
								? {
										excludeBranches: payload.exclude_branches,
									}
								: undefined),
							...(payload.scrape_interval_seconds !== undefined
								? {
										scrapeIntervalSeconds: payload.scrape_interval_seconds,
									}
								: undefined),
							...(payload.labels_json !== undefined
								? { labelsJson: payload.labels_json }
								: undefined),
							...(payload.auth_type !== undefined
								? { authType: payload.auth_type }
								: undefined),
							...(payload.service_name !== undefined
								? { serviceName: payload.service_name }
								: undefined),
							...(payload.auth_credentials !== undefined
								? {
										authCredentials: payload.auth_credentials,
									}
								: undefined),
							...(payload.enabled !== undefined ? { enabled: payload.enabled } : undefined),
						}),
					)

					yield* recordHttpAudit("scrape_target.created", {
						resourceId: created.id,
						metadata: { name: created.name },
					})

					return forReader(toV2ScrapeTarget(created), canManageTargets(tenant))
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Policy.check(tenant.roles, "scrape_targets:manage", (denial) =>
						V2InsufficientPermissions.make(denial.message),
					)
					const current = yield* service.get(tenant.orgId, params.id)
					const updated = yield* service.update(
						tenant.orgId,
						params.id,
						new UpdateScrapeTargetRequest({
							...(payload.name !== undefined ? { name: payload.name } : undefined),
							...(payload.url !== undefined ? { url: payload.url } : undefined),
							...(payload.organization !== undefined
								? { organization: payload.organization }
								: undefined),
							...(payload.include_branches !== undefined
								? {
										includeBranches: payload.include_branches,
									}
								: undefined),
							...(payload.exclude_branches !== undefined
								? {
										excludeBranches: payload.exclude_branches,
									}
								: undefined),
							...(payload.scrape_interval_seconds !== undefined
								? {
										scrapeIntervalSeconds: payload.scrape_interval_seconds,
									}
								: undefined),
							...(payload.labels_json !== undefined
								? { labelsJson: payload.labels_json }
								: undefined),
							...(payload.auth_type !== undefined
								? { authType: payload.auth_type }
								: undefined),
							...(payload.service_name !== undefined
								? { serviceName: payload.service_name }
								: undefined),
							...(payload.auth_credentials !== undefined
								? {
										authCredentials: payload.auth_credentials,
									}
								: undefined),
							...(payload.enabled !== undefined ? { enabled: payload.enabled } : undefined),
						}),
					)

					// Read-then-write with no CAS: a concurrent update can make `before`
					// reflect a state this update never saw. Accepted for audit purposes.
					yield* recordHttpAudit("scrape_target.updated", {
						resourceId: updated.id,
						changes: targetAuditDiff(
							payload,
							toV2ScrapeTarget(current),
							toV2ScrapeTarget(updated),
						),
						metadata: { name: updated.name },
					})

					return forReader(toV2ScrapeTarget(updated), canManageTargets(tenant))
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Policy.check(tenant.roles, "scrape_targets:manage", (denial) =>
						V2InsufficientPermissions.make(denial.message),
					)
					const deleted = yield* service.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("scrape_target.deleted", { resourceId: deleted.id })

					return { id: deleted.id, object: "scrape_target" as const, deleted: true as const }
				}),
			)
			.handle("probe", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Policy.check(tenant.roles, "scrape_targets:manage", (denial) =>
						V2InsufficientPermissions.make(denial.message),
					)
					const result = yield* service.probe(tenant.orgId, params.id)

					return {
						object: "scrape_target.probe_result" as const,
						success: result.success,
						last_scrape_at: result.lastScrapeAt,
						last_scrape_error: result.lastScrapeError,
					}
				}),
			)
			.handle("listChecks", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						service
							.listChecks(tenant.orgId, params.id, {
								...(query.since !== undefined
									? { startTime: timestampMs(query.since) }
									: undefined),
								...(query.until !== undefined
									? { endTime: timestampMs(query.until) }
									: undefined),
								limit,
								offset,
							})
							.pipe(
								Effect.map((rows): ReadonlyArray<V2ScrapeTargetCheck> =>
									Arr.map(rows, (row) => ({
										object: "scrape_target.check" as const,
										timestamp: timestamp(new Date(row.checkedAt).toISOString()),
										success: row.error === null,
										sub_target_key: row.subTargetKey === "" ? null : row.subTargetKey,
										duration_seconds:
											row.durationMs === null ? null : row.durationMs / 1000,
										samples_scraped: row.samplesScraped,
										samples_post_metric_relabeling: row.samplesPostRelabel,
										message: row.error,
									})),
								),
							),
					)
					return { object: "list" as const, ...page }
				}),
			)
	}),
)
