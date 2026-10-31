import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	StatusPageComponentNotFoundError,
	StatusPageNotFoundError,
	StatusPagePersistenceError,
	StatusPagesDisabledError,
	type StatusPageComponentRecord,
	type StatusPageIncidentRecord,
	type StatusPageRecord,
} from "@maple/domain/http"
import {
	isoTimestamp,
	isoTimestampOrNull,
	MapleApiV2,
	paginateArray,
	paginateOffsetQuery,
	V2InsufficientPermissions,
	type V2StatusPage,
	type V2StatusPageComponent,
	type V2StatusPageIncident,
	hasStatusPageConfigChanges,
} from "@maple/domain/http/v2"
import type {
	OrgId,
	StatusPageComponentId,
	StatusPageId,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
} from "@maple/domain/primitives"
import { DEFAULT_STATUS_PAGE_THEME, isActiveIncident } from "@maple/domain/status-page"
import { Clock, Effect, Option } from "effect"
import { auditDiff, diffAuditChanges } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { timestampMs } from "@maple/backend/platform/time"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import {
	OrganizationFeatureFlagsService,
	type OrganizationFeatureFlagsServiceApi,
} from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { StatusPagePublisher } from "@maple/backend/services/status-pages/StatusPagePublisher"
import {
	StatusPageSnapshotBuilder,
	toStatusPageDraft,
} from "@maple/backend/services/status-pages/StatusPageSnapshotBuilder"
import { StatusPagesService } from "@maple/backend/services/status-pages/StatusPagesService"
import { StatusPageStore } from "@maple/backend/services/status-pages/StatusPageStore"

// Page settings, components and the break-glass token are admin-gated: they change what the
// public sees about the whole org. Incidents stay open to any writer, so responders can post.
const adminOnly = (action: string) => () =>
	V2InsufficientPermissions.make(`Only org admins can ${action} status pages`)

/** The caller's tenant, once its org is in the `statusPages` rollout. */
const tenantInRollout = (featureFlags: OrganizationFeatureFlagsServiceApi) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentTenant.Context
		const flags = yield* featureFlags.flags(tenant.orgId)
		if (!flags.statusPages) {
			return yield* new StatusPagesDisabledError({
				message: "Status pages are not enabled for this organization.",
			})
		}
		return tenant
	})

export const toV2StatusPage = (page: StatusPageRecord): V2StatusPage => ({
	id: page.id,
	object: "status_page",
	name: page.name,
	slug: page.slug,
	description: page.description,
	website_url: page.websiteUrl,
	logo_url: page.logoUrl,
	privacy_url: page.privacyUrl,
	terms_url: page.termsUrl,
	theme: page.theme,
	show_powered_by: page.showPoweredBy,
	auto_incidents: page.autoIncidents,
	break_glass_token_suffix: page.breakGlassTokenSuffix,
	draft: page.draft,
	revision: page.revision,
	published_revision: page.publishedRevision,
	published_at: isoTimestampOrNull(page.publishedAt),
	last_publish_error: page.lastPublishError,
	created_at: isoTimestamp(page.createdAt),
	updated_at: isoTimestamp(page.updatedAt),
})

export const toV2StatusPageComponent = (component: StatusPageComponentRecord): V2StatusPageComponent => ({
	id: component.id,
	object: "status_page_component",
	page_id: component.pageId,
	name: component.name,
	description: component.description,
	group: component.groupName,
	position: component.position,
	monitor_id: component.monitorId,
	manual_status: component.manualStatus,
	show_uptime: component.showUptime,
	created_at: isoTimestamp(component.createdAt),
	updated_at: isoTimestamp(component.updatedAt),
})

export const toV2StatusPageIncident = (incident: StatusPageIncidentRecord): V2StatusPageIncident => ({
	id: incident.id,
	object: "status_page_incident",
	page_id: incident.pageId,
	kind: incident.kind,
	title: incident.title,
	impact: incident.impact,
	status: incident.status,
	published: incident.published,
	scheduled_start: isoTimestampOrNull(incident.scheduledStart),
	scheduled_end: isoTimestampOrNull(incident.scheduledEnd),
	started_at: isoTimestamp(incident.startedAt),
	resolved_at: isoTimestampOrNull(incident.resolvedAt),
	component_ids: incident.componentIds,
	updates: incident.updates.map((update) => ({
		id: update.id,
		status: update.status,
		body: update.body,
		source: update.source,
		created_at: isoTimestamp(update.createdAt),
	})),
	created_at: isoTimestamp(incident.createdAt),
	updated_at: isoTimestamp(incident.updatedAt),
})

const pageAuditDiff = auditDiff({
	fields: [
		"name",
		"slug",
		"description",
		"website_url",
		"logo_url",
		"privacy_url",
		"terms_url",
		"theme",
		"show_powered_by",
		"auto_incidents",
	],
})

const componentAuditDiff = auditDiff({
	fields: ["name", "description", "group", "monitor_id", "manual_status", "show_uptime"],
})

const incidentAuditDiff = auditDiff({
	fields: ["title", "impact", "published", "scheduled_start", "scheduled_end", "component_ids"],
})

const DEFAULT_STATUS = {
	incident: "investigating",
	maintenance: "scheduled",
} as const satisfies Record<StatusPageIncidentKind, StatusPageIncidentStatus>

const DEFAULT_IMPACT = {
	incident: "minor",
	maintenance: "none",
} as const satisfies Record<StatusPageIncidentKind, StatusPageIncidentImpact>

const parseTimestamp = (value: string | null | undefined) =>
	value === undefined ? undefined : value === null ? null : timestampMs(value)

const publishFailed = (message: string) => new StatusPagePersistenceError({ message })

export const HttpV2StatusPagesLive = HttpApiBuilder.group(MapleApiV2, "statusPages", (handlers) =>
	Effect.gen(function* () {
		const service = yield* StatusPagesService
		const snapshotBuilder = yield* StatusPageSnapshotBuilder
		const enabledTenant = tenantInRollout(yield* OrganizationFeatureFlagsService)

		/** The component, only when it is on this page; anything else reads as not found. */
		const requireComponentOnPage = (
			orgId: OrgId,
			pageId: StatusPageId,
			componentId: StatusPageComponentId,
		) =>
			service.listComponents(orgId, pageId).pipe(
				Effect.flatMap((components) => {
					const component = components.find((candidate) => candidate.id === componentId)
					return component === undefined
						? Effect.fail(
								new StatusPageComponentNotFoundError({
									componentId,
									message: "Status page component not found",
								}),
							)
						: Effect.succeed(component)
				}),
			)

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					const pages = yield* service.list(tenant.orgId)
					const page = yield* paginateArray(pages.map(toV2StatusPage), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("preview", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					const nowMs = yield* Clock.currentTimeMillis
					return yield* snapshotBuilder
						.buildDraft(tenant.orgId, toStatusPageDraft(payload), nowMs)
						.pipe(
							Effect.catchTag("@maple/backend/status-pages/StatusPagePublishDbError", (error) =>
								Effect.fail(publishFailed(error.message)),
							),
						)
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					return toV2StatusPage(yield* service.get(tenant.orgId, params.id))
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("create"))
					const created = yield* service.create(tenant.orgId, {
						name: payload.name,
						slug: payload.slug,
						...(payload.description === undefined
							? undefined
							: { description: payload.description }),
						...(payload.website_url === undefined
							? undefined
							: { websiteUrl: payload.website_url }),
						...(payload.logo_url === undefined ? undefined : { logoUrl: payload.logo_url }),
						...(payload.privacy_url === undefined
							? undefined
							: { privacyUrl: payload.privacy_url }),
						...(payload.terms_url === undefined ? undefined : { termsUrl: payload.terms_url }),
						...(payload.theme === undefined
							? undefined
							: { theme: { ...DEFAULT_STATUS_PAGE_THEME, ...payload.theme } }),
						...(payload.show_powered_by === undefined
							? undefined
							: { showPoweredBy: payload.show_powered_by }),
						...(payload.auto_incidents === undefined
							? undefined
							: { autoIncidents: payload.auto_incidents }),
						...(payload.components === undefined
							? undefined
							: { components: payload.components }),
						draft: payload.publish === false,
						createdBy: tenant.userId,
					})
					yield* recordHttpAudit("status_page.created", {
						resourceId: created.id,
						metadata: { name: created.name, slug: created.slug },
					})
					if (payload.publish !== true) return toV2StatusPage(created)
					// The page is created either way: a failed publish leaves it queued for the minutely sweep.
					const publisher = yield* Effect.serviceOption(StatusPagePublisher)
					if (Option.isNone(publisher)) return toV2StatusPage(created)
					yield* publisher.value.publish(created.id).pipe(
						Effect.catch((error) =>
							Effect.logWarning("Status page publish after create failed").pipe(
								Effect.annotateLogs({
									"maple.status_page.id": created.id,
									"error.type": error._tag,
									"error.message": error.message,
								}),
							),
						),
					)
					// Re-read for the publish state; a page deleted meanwhile answers as created.
					const current = yield* service
						.get(tenant.orgId, created.id)
						.pipe(
							Effect.catchTag("@maple/http/errors/StatusPageNotFoundError", () =>
								Effect.succeed(created),
							),
						)
					return toV2StatusPage(current)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("update"))
					const current = yield* service.get(tenant.orgId, params.id)
					const updated = yield* service.update(tenant.orgId, params.id, {
						...(payload.name === undefined ? undefined : { name: payload.name }),
						...(payload.slug === undefined ? undefined : { slug: payload.slug }),
						...(payload.description === undefined
							? undefined
							: { description: payload.description }),
						...(payload.website_url === undefined
							? undefined
							: { websiteUrl: payload.website_url }),
						...(payload.logo_url === undefined ? undefined : { logoUrl: payload.logo_url }),
						...(payload.privacy_url === undefined
							? undefined
							: { privacyUrl: payload.privacy_url }),
						...(payload.terms_url === undefined ? undefined : { termsUrl: payload.terms_url }),
						// Omitted theme fields keep the page's current values.
						...(payload.theme === undefined ? undefined : { theme: payload.theme }),
						...(payload.show_powered_by === undefined
							? undefined
							: { showPoweredBy: payload.show_powered_by }),
						...(payload.auto_incidents === undefined
							? undefined
							: { autoIncidents: payload.auto_incidents }),
					})
					yield* recordHttpAudit("status_page.updated", {
						resourceId: updated.id,
						changes: pageAuditDiff(payload, toV2StatusPage(current), toV2StatusPage(updated)),
						metadata: { name: updated.name },
					})
					return toV2StatusPage(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("delete"))
					const current = yield* service.get(tenant.orgId, params.id)
					const deleted = yield* service.remove(tenant.orgId, params.id)
					// Best effort: the row is gone, so the page must not stay up; a failure is logged.
					const store = yield* Effect.serviceOption(StatusPageStore)
					if (Option.isSome(store)) {
						// The slug route only while it still names this page: slugs free up for reuse at once.
						yield* store.value.deletePage(deleted).pipe(
							Effect.andThen(store.value.readSlugRoute(current.slug)),
							Effect.flatMap((owner) =>
								owner === deleted
									? store.value.deleteRoutes({ slug: current.slug, hostnames: [] })
									: Effect.void,
							),
							Effect.catch((error) =>
								Effect.logWarning("Status page edge data not deleted").pipe(
									Effect.annotateLogs({
										"maple.status_page.id": deleted,
										"error.type": error._tag,
										"error.message": error.message,
									}),
								),
							),
						)
					}
					yield* recordHttpAudit("status_page.deleted", {
						resourceId: deleted,
						metadata: { name: current.name, slug: current.slug },
					})
					return { id: deleted, object: "status_page" as const, deleted: true as const }
				}),
			)
			.handle("publish", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("publish"))
					// A draft goes public first, so the publish below writes it.
					const page = yield* service.makePublic(tenant.orgId, params.id)
					const publisher = yield* Effect.serviceOption(StatusPagePublisher)
					// Without edge storage bound here the minutely sweep publishes it.
					const outcome = Option.isNone(publisher)
						? { outcome: "queued" as const, revision: page.revision }
						: yield* publisher.value.publish(page.id).pipe(
								Effect.map((result) => ({
									outcome: result.written ? ("published" as const) : ("unchanged" as const),
									revision: result.revision,
								})),
								Effect.catchTags({
									"@maple/backend/status-pages/StatusPageGoneError": () =>
										Effect.fail(
											new StatusPageNotFoundError({
												pageId: page.id,
												message: "Status page not found",
											}),
										),
									"@maple/backend/status-pages/StatusPagePublishDbError": (error) =>
										Effect.fail(publishFailed(error.message)),
									"@maple/backend/status-pages/StatusPageStoreError": (error) =>
										Effect.fail(publishFailed(error.message)),
								}),
							)
					yield* recordHttpAudit("status_page.published", {
						resourceId: page.id,
						metadata: { outcome: outcome.outcome, revision: outcome.revision },
					})
					return { id: page.id, object: "status_page.publish_result" as const, ...outcome }
				}),
			)
			.handle("rotateBreakGlass", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("issue break-glass tokens for"))
					const token = yield* service.rotateBreakGlassToken(tenant.orgId, params.id)
					yield* recordHttpAudit("status_page.break_glass_rotated", { resourceId: params.id })
					return {
						id: params.id,
						object: "status_page.break_glass_token" as const,
						token,
						token_suffix: token.slice(-6),
					}
				}),
			)
			.handle("revokeBreakGlass", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("revoke break-glass tokens for"))
					yield* service.revokeBreakGlassToken(tenant.orgId, params.id)
					yield* recordHttpAudit("status_page.break_glass_revoked", { resourceId: params.id })
					return toV2StatusPage(yield* service.get(tenant.orgId, params.id))
				}),
			)
			.handle("getConfig", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					return yield* service.getConfig(tenant.orgId, params.id)
				}),
			)
			.handle("applyConfig", ({ params, query, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("update"))
					const { previous, config, changes } = yield* service.applyConfig(
						tenant.orgId,
						params.id,
						payload,
						tenant.userId,
						{ ifVersion: query.if_version },
					)
					const { components: _before, version: _beforeVersion, ...pageBefore } = previous
					const { components: _after, version: _afterVersion, ...pageAfter } = config
					if (!hasStatusPageConfigChanges(changes)) return config
					yield* recordHttpAudit("status_page.config_applied", {
						resourceId: params.id,
						changes: diffAuditChanges(pageBefore, pageAfter),
						metadata: {
							name: config.name,
							components_created: changes.created.length,
							components_updated: changes.updated.length,
							components_deleted: changes.deleted.length,
							components_reordered: changes.reordered,
						},
					})
					return config
				}),
			)
			.handle("listComponents", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					const components = yield* service.listComponents(tenant.orgId, params.id)
					const page = yield* paginateArray(components.map(toV2StatusPageComponent), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("createComponent", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("edit"))
					const created = yield* service.createComponent(tenant.orgId, params.id, {
						name: payload.name,
						...(payload.description === undefined
							? undefined
							: { description: payload.description }),
						...(payload.group === undefined ? undefined : { groupName: payload.group }),
						...(payload.monitor_id === undefined ? undefined : { monitorId: payload.monitor_id }),
						...(payload.manual_status === undefined
							? undefined
							: { manualStatus: payload.manual_status }),
						...(payload.show_uptime === undefined
							? undefined
							: { showUptime: payload.show_uptime }),
					})
					yield* recordHttpAudit("status_page_component.created", {
						resourceId: created.id,
						metadata: { name: created.name, page_id: params.id },
					})
					return toV2StatusPageComponent(created)
				}),
			)
			.handle("reorderComponents", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("edit"))
					const components = yield* service.reorderComponents(
						tenant.orgId,
						params.id,
						payload.component_ids,
					)
					yield* recordHttpAudit("status_page.components_reordered", { resourceId: params.id })
					return {
						object: "list" as const,
						data: components.map(toV2StatusPageComponent),
						has_more: false,
						next_cursor: null,
					}
				}),
			)
			.handle("updateComponent", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("edit"))
					const current = yield* requireComponentOnPage(
						tenant.orgId,
						params.id,
						params.component_id,
					)
					const updated = yield* service.updateComponent(tenant.orgId, params.component_id, {
						...(payload.name === undefined ? undefined : { name: payload.name }),
						...(payload.description === undefined
							? undefined
							: { description: payload.description }),
						...(payload.group === undefined ? undefined : { groupName: payload.group }),
						...(payload.monitor_id === undefined ? undefined : { monitorId: payload.monitor_id }),
						...(payload.manual_status === undefined
							? undefined
							: { manualStatus: payload.manual_status }),
						...(payload.show_uptime === undefined
							? undefined
							: { showUptime: payload.show_uptime }),
					})
					yield* recordHttpAudit("status_page_component.updated", {
						resourceId: updated.id,
						changes: componentAuditDiff(
							payload,
							toV2StatusPageComponent(current),
							toV2StatusPageComponent(updated),
						),
						metadata: { name: updated.name, page_id: params.id },
					})
					return toV2StatusPageComponent(updated)
				}),
			)
			.handle("deleteComponent", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* enabledTenant
					yield* requireAdmin(tenant.roles, adminOnly("edit"))
					const current = yield* requireComponentOnPage(
						tenant.orgId,
						params.id,
						params.component_id,
					)
					const removed = yield* service.removeComponent(tenant.orgId, params.component_id)
					yield* recordHttpAudit("status_page_component.deleted", {
						resourceId: removed,
						metadata: { name: current.name, page_id: params.id },
					})
					return { id: removed, object: "status_page_component" as const, deleted: true as const }
				}),
			)
	}),
)

export const HttpV2StatusPageIncidentsLive = HttpApiBuilder.group(
	MapleApiV2,
	"statusPageIncidents",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* StatusPagesService
			const enabledTenant = tenantInRollout(yield* OrganizationFeatureFlagsService)

			return handlers
				.handle("list", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* enabledTenant
						const state = query.state ?? "open"
						const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
							service.listOrgIncidents(tenant.orgId, {
								pageId: query.page_id ?? null,
								state,
								limit,
								offset,
							}),
						)
						const data = page.data.map(toV2StatusPageIncident)
						return { object: "list" as const, ...page, data }
					}),
				)
				.handle("retrieve", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* enabledTenant
						return toV2StatusPageIncident(yield* service.getIncident(tenant.orgId, params.id))
					}),
				)
				.handle("create", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* enabledTenant
						const kind = payload.kind ?? "incident"
						const created = yield* service.createIncident(tenant.orgId, payload.page_id, {
							kind,
							title: payload.title,
							impact: payload.impact ?? DEFAULT_IMPACT[kind],
							status: payload.status ?? DEFAULT_STATUS[kind],
							body: payload.body,
							componentIds: payload.component_ids ?? [],
							...(payload.published === undefined
								? undefined
								: { published: payload.published }),
							...(payload.scheduled_start === undefined
								? undefined
								: { scheduledStart: timestampMs(payload.scheduled_start) }),
							...(payload.scheduled_end === undefined
								? undefined
								: { scheduledEnd: timestampMs(payload.scheduled_end) }),
							source: "api",
							createdBy: tenant.userId,
						})
						yield* recordHttpAudit("status_page_incident.created", {
							resourceId: created.id,
							metadata: {
								title: created.title,
								kind: created.kind,
								page_id: created.pageId,
								published: created.published,
							},
						})
						return toV2StatusPageIncident(created)
					}),
				)
				.handle("update", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* enabledTenant
						const current = yield* service.getIncident(tenant.orgId, params.id)
						const scheduledStart = parseTimestamp(payload.scheduled_start)
						const scheduledEnd = parseTimestamp(payload.scheduled_end)
						const updated = yield* service.updateIncident(tenant.orgId, params.id, {
							...(payload.title === undefined ? undefined : { title: payload.title }),
							...(payload.impact === undefined ? undefined : { impact: payload.impact }),
							...(payload.published === undefined
								? undefined
								: { published: payload.published }),
							...(scheduledStart === undefined ? undefined : { scheduledStart }),
							...(scheduledEnd === undefined ? undefined : { scheduledEnd }),
							...(payload.component_ids === undefined
								? undefined
								: { componentIds: payload.component_ids }),
						})
						yield* recordHttpAudit("status_page_incident.updated", {
							resourceId: updated.id,
							changes: incidentAuditDiff(
								payload,
								toV2StatusPageIncident(current),
								toV2StatusPageIncident(updated),
							),
							metadata: { title: updated.title, page_id: updated.pageId },
						})
						return toV2StatusPageIncident(updated)
					}),
				)
				.handle("delete", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* enabledTenant
						const current = yield* service.getIncident(tenant.orgId, params.id)
						const removed = yield* service.removeIncident(tenant.orgId, params.id)
						yield* recordHttpAudit("status_page_incident.deleted", {
							resourceId: removed,
							metadata: { title: current.title, page_id: current.pageId },
						})
						return {
							id: removed,
							object: "status_page_incident" as const,
							deleted: true as const,
						}
					}),
				)
				.handle("postUpdate", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* enabledTenant
						const updated = yield* service.postUpdate(tenant.orgId, params.id, {
							status: payload.status,
							body: payload.body,
							...(payload.impact === undefined ? undefined : { impact: payload.impact }),
							...(payload.component_ids === undefined
								? undefined
								: { componentIds: payload.component_ids }),
							source: "api",
							createdBy: tenant.userId,
						})
						yield* recordHttpAudit("status_page_incident.update_posted", {
							resourceId: updated.id,
							metadata: {
								status: updated.status,
								page_id: updated.pageId,
								active: isActiveIncident(updated),
							},
						})
						return toV2StatusPageIncident(updated)
					}),
				)
		}),
)
