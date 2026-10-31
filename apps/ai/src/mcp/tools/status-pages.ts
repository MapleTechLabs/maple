/**
 * Status pages: what the org's customers see about its health. Anyone may read them and run
 * incidents, like the REST routes; an agent's incident starts as a draft unless it asks to publish,
 * because every update is public text on the customer's page.
 */
import { Clock, Effect, Schema } from "effect"
import {
	ApplyStatusPageConfigOutput,
	GetStatusPageConfigOutput,
	GetStatusPageOutput,
	ListStatusPagesOutput,
	StatusPageIncidentMutationOutput,
	type StatusPageIncidentRow,
	type StatusPageRow,
} from "@maple/domain/mcp-outputs"
import {
	decodePublicId,
	encodePublicId,
	hasStatusPageConfigChanges,
	PublicIdPrefixes,
	StatusPageConfig,
} from "@maple/domain/http/v2"
import type {
	StatusPageComponentRecord,
	StatusPageIncidentRecord,
	StatusPageRecord,
} from "@maple/domain/http"
import {
	StatusPageIncidentId,
	StatusPageIncidentImpact,
	type OrgId,
	type StatusPageComponentId,
	type StatusPageIncidentStatus,
} from "@maple/domain/primitives"
import { isActiveIncident, overallStatus, pageFreshness } from "@maple/domain/status-page"
import { parseWarehouseDateTime, WarehouseTimeInput } from "@maple/query-engine"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { auditAttribution } from "@maple/backend/services/audit/audit-access"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { StatusPagesService } from "@maple/backend/services/status-pages/StatusPagesService"
import { StatusPageSnapshotBuilder } from "@maple/backend/services/status-pages/StatusPageSnapshotBuilder"
import { McpInvalidInputError, McpQueryError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const INCIDENT_STATUSES = ["investigating", "identified", "monitoring"] as const
const MUTATION_HINTS = { readOnly: false, destructive: false, idempotent: false, openWorld: true } as const
const encodeConfig = Schema.encodeSync(StatusPageConfig)

const iso = (ms: number) => new Date(ms).toISOString()
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms))

/** Service failures as tool errors: a missing or invalid reference is the caller's to fix. */
const toMcpError =
	(tool: string) =>
	(error: { readonly _tag: string; readonly message: string }): McpInvalidInputError | McpQueryError => {
		switch (error._tag) {
			case "@maple/http/errors/StatusPageNotFoundError":
			case "@maple/backend/status-pages/StatusPageGoneError":
				return new McpInvalidInputError({
					message: "No such status page. list_status_pages lists them.",
					parameter: "page",
				})
			case "@maple/http/errors/StatusPageIncidentNotFoundError":
				return new McpInvalidInputError({
					message: "No such status page incident. get_status_page lists a page's open incidents.",
					parameter: "incident",
				})
			case "@maple/http/errors/StatusPageComponentNotFoundError":
				return new McpInvalidInputError({
					message: "No such component. get_status_page lists a page's components.",
					parameter: "components",
				})
			case "@maple/http/errors/StatusPageValidationError":
			case "@maple/http/errors/StatusPageSlugTakenError":
				return new McpInvalidInputError({ message: error.message })
			case "@maple/http/errors/StatusPageConflictError":
				return new McpInvalidInputError({
					message: `${error.message} Nothing was applied. Call get_status_page_config again and redo the edit on the fresh document; applying the old one would undo the other change.`,
					parameter: "if_version",
				})
			default:
				return new McpQueryError({ message: `${error._tag}: ${error.message}`, pipeName: tool })
		}
	}

const toPageRow = (page: StatusPageRecord): typeof StatusPageRow.Type => ({
	id: encodePublicId(PublicIdPrefixes.statusPage, page.id),
	name: page.name,
	slug: page.slug,
	autoIncidents: page.autoIncidents,
	revision: page.revision,
	publishedRevision: page.publishedRevision,
	publishedAt: isoOrNull(page.publishedAt),
	lastPublishError: page.lastPublishError,
})

const toIncidentRow = (incident: StatusPageIncidentRecord): typeof StatusPageIncidentRow.Type => {
	const latest = incident.updates[0]
	return {
		id: encodePublicId(PublicIdPrefixes.statusPageIncident, incident.id),
		pageId: encodePublicId(PublicIdPrefixes.statusPage, incident.pageId),
		kind: incident.kind,
		title: incident.title,
		impact: incident.impact,
		status: incident.status,
		published: incident.published,
		startedAt: iso(incident.startedAt),
		resolvedAt: isoOrNull(incident.resolvedAt),
		scheduledStart: isoOrNull(incident.scheduledStart),
		scheduledEnd: isoOrNull(incident.scheduledEnd),
		componentIds: incident.componentIds.map((id) =>
			encodePublicId(PublicIdPrefixes.statusPageComponent, id),
		),
		latestUpdate:
			latest === undefined
				? null
				: { status: latest.status, body: latest.body, at: iso(latest.createdAt) },
		updateCount: incident.updates.length,
	}
}

/** A page by its id, REST id (`stp_…`), slug or exact name. */
const resolvePage = Effect.fnUntraced(function* (tool: string, orgId: OrgId, ref: string) {
	const service = yield* StatusPagesService
	const pages = yield* service.list(orgId).pipe(Effect.mapError(toMcpError(tool)))
	const value = ref.trim()
	const id = decodePublicId(PublicIdPrefixes.statusPage, value) ?? value
	const matches = pages.filter((page) => page.id === id || page.slug === value || page.name === value)
	const [page] = matches
	if (page === undefined) {
		return yield* new McpInvalidInputError({
			message: `No status page "${ref}". list_status_pages lists them.`,
			parameter: "page",
		})
	}
	if (matches.length > 1) {
		return yield* new McpInvalidInputError({
			message: `${matches.length} status pages match "${ref}"; pass one's slug or id instead.`,
			parameter: "page",
		})
	}
	return page
})

const decodeIncidentId = (ref: string) => {
	const value = ref.trim()
	return Schema.decodeUnknownEffect(StatusPageIncidentId)(
		decodePublicId(PublicIdPrefixes.statusPageIncident, value) ?? value,
	).pipe(
		Effect.mapError(
			() =>
				new McpInvalidInputError({
					message: `"${ref}" is not a status page incident id (sti_… or its UUID). get_status_page lists open incidents.`,
					parameter: "incident",
				}),
		),
	)
}

/** Component references (id, `stc_…` or exact name) resolved against the page's components. */
const resolveComponents = (
	components: ReadonlyArray<StatusPageComponentRecord>,
	refs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<StatusPageComponentId>, McpInvalidInputError> =>
	Effect.forEach(refs, (ref) => {
		const value = ref.trim()
		const id = decodePublicId(PublicIdPrefixes.statusPageComponent, value) ?? value
		const found = components.find((component) => component.id === id || component.name === value)
		return found === undefined
			? Effect.fail(
					new McpInvalidInputError({
						message: `No component "${ref}" on this page. Its components: ${components.map((c) => c.name).join(", ") || "none"}.`,
						parameter: "components",
					}),
				)
			: Effect.succeed(found.id)
	})

const pageComponents = Effect.fnUntraced(function* (
	tool: string,
	orgId: OrgId,
	pageId: StatusPageRecord["id"],
) {
	const service = yield* StatusPagesService
	return yield* service.listComponents(orgId, pageId).pipe(Effect.mapError(toMcpError(tool)))
})

const renderIncident = (title: string, output: typeof StatusPageIncidentMutationOutput.Type) => {
	const incident = output.incident
	return {
		title,
		notices: incident.published
			? []
			: incident.resolvedAt === null
				? [
						"This is a draft: it is not on the public page. post_status_page_update with publish=true publishes it.",
					]
				: // A closed draft must not be pointed at post_status_page_update: its statuses reopen it.
					["This was closed as a draft, so it never appeared on the public page."],
		blocks: [
			doc.fields([
				["Title", incident.title],
				["Id", incident.id],
				["Kind", incident.kind],
				["Status", incident.status],
				["Impact", incident.impact],
				["Published", incident.published ? "yes" : "no (draft)"],
				[
					"Window",
					incident.scheduledStart === null
						? undefined
						: `${incident.scheduledStart} to ${incident.scheduledEnd ?? "?"}`,
				],
				["Latest update", incident.latestUpdate?.body],
			]),
		],
		next: [doc.next("get_status_page", { page: incident.pageId }, "the page with this incident")],
	}
}

/** A required UTC time; annotated on the wire side, where the published schema reads it. */
const utcTime = (meaning: string) =>
	Schema.String.annotate({ description: `${meaning}, UTC (YYYY-MM-DD HH:mm:ss or ISO 8601)` }).pipe(
		Schema.decodeTo(WarehouseTimeInput),
	)

const publishParameter = P.optionalFlag(
	"true puts it on the public page now. Default false: a draft a person reviews and publishes",
)

export function registerStatusPageTools(server: McpToolRegistrar) {
	server.define({
		name: "list_status_pages",
		title: "List Status Pages",
		description:
			"Every public status page of the org with its slug and publish state (revision vs published revision, last publish error). get_status_page shows one page's components, open incidents and freshness.",
		parameters: Schema.Struct({}),
		output: ListStatusPagesOutput,
		hints: { readOnly: true, destructive: false, idempotent: true },
		phrases: ["Checking status pages"],
		handler: Effect.fn("McpTool.listStatusPages")(function* () {
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService
			const pages = yield* service
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpError("list_status_pages")))
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": pages.length })
			return { pages: pages.map(toPageRow), total: pages.length }
		}),
		render: (output) => ({
			title: "Status pages",
			...(output.pages.length === 0
				? {
						empty: {
							message: "This organization has no status pages.",
							hints: ["Create one in Maple under Status pages, or with POST /v2/status_pages."],
						},
					}
				: undefined),
			blocks:
				output.pages.length === 0
					? []
					: [
							doc.table(
								["Name", "Slug", "Id", "Published", "Publish error"],
								output.pages.map((page) => [
									page.name,
									page.slug,
									page.id,
									page.publishedAt === null
										? "not yet"
										: page.publishedRevision < page.revision
											? `${page.publishedAt} (change pending)`
											: page.publishedAt,
									page.lastPublishError ?? "-",
								]),
							),
						],
			next: output.pages
				.slice(0, 3)
				.map((page) =>
					doc.next(
						"get_status_page",
						{ page: page.slug },
						`${page.name}'s components and incidents`,
					),
				),
		}),
	})

	server.define({
		name: "get_status_page",
		title: "Get Status Page",
		description:
			"One status page as its visitors see it: each component's status (worst of its uptime monitor, manual override and published incidents), the overall banner, open incidents and maintenance (drafts included, marked), and whether its live checks are fresh or delayed.",
		parameters: Schema.Struct({
			page: P.text("The page's slug, name or id (list_status_pages lists them)"),
		}),
		output: GetStatusPageOutput,
		hints: { readOnly: true, destructive: false, idempotent: true },
		phrases: ["Reading a status page"],
		handler: Effect.fn("McpTool.getStatusPage")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService
			const builder = yield* StatusPageSnapshotBuilder
			const page = yield* resolvePage("get_status_page", tenant.orgId, params.page)
			const nowMs = yield* Clock.currentTimeMillis
			// The builder reads by page id; `resolvePage` already scoped it to this org.
			const snapshot = yield* builder
				.build(page.id, nowMs)
				.pipe(Effect.mapError(toMcpError("get_status_page")))
			const records = yield* pageComponents("get_status_page", tenant.orgId, page.id)
			const incidents = yield* service
				.listIncidents(tenant.orgId, page.id)
				.pipe(Effect.mapError(toMcpError("get_status_page")))
			// Answering means Maple is up, so this is the probe side of freshness only, scoped to this org.
			const probesSeenAt = yield* builder
				.probesSeenAt(nowMs, tenant.orgId)
				.pipe(Effect.mapError(toMcpError("get_status_page")))
			const monitored = snapshot.components.some((component) => component.monitored)
			// No recent probe at all is the most delayed a monitored page can be, not "live now".
			const freshness =
				monitored && probesSeenAt === null
					? { _tag: "delayed" as const, updatedAt: null }
					: pageFreshness({ snapshot, heartbeat: { at: nowMs, probesSeenAt }, nowMs })
			return {
				page: toPageRow(page),
				overallStatus: overallStatus(snapshot),
				components: snapshot.components.map((component) => {
					const record = records.find((candidate) => candidate.id === component.id)
					return {
						id: encodePublicId(PublicIdPrefixes.statusPageComponent, component.id),
						name: component.name,
						group: component.group,
						status: component.status,
						monitorId:
							record?.monitorId == null
								? null
								: encodePublicId(PublicIdPrefixes.uptimeMonitor, record.monitorId),
						manualStatus: record?.manualStatus ?? null,
					}
				}),
				activeIncidents: incidents.map(toIncidentRow),
				freshness: {
					state: freshness._tag,
					updatedAt: freshness.updatedAt === null ? null : iso(freshness.updatedAt),
					publishPending: page.publishedRevision < page.revision,
				},
			}
		}),
		render: (output) => ({
			title: `Status page: ${output.page.name}`,
			notices: [
				// No suggested call: both follow-ups need a public message only the user can word.
				...(output.activeIncidents.some((incident) => isActiveIncident(incident))
					? [
							"To update an open incident, call post_status_page_update (incident, status, message) or resolve_status_page_incident (incident, message) with wording the user approves.",
						]
					: []),
				...(output.freshness.state === "delayed"
					? [
							output.freshness.updatedAt === null
								? "Live checks are delayed: none of the page's monitors has reported in the last two days."
								: `Live checks are delayed: the page's monitors last reported at ${output.freshness.updatedAt}.`,
						]
					: []),
				...(output.page.lastPublishError === null
					? []
					: [
							`The last publish failed: ${output.page.lastPublishError}. The next minutely publish retries.`,
						]),
			],
			blocks: [
				doc.fields([
					["Slug", output.page.slug],
					["Id", output.page.id],
					["Overall", output.overallStatus],
					["Published", output.page.publishedAt ?? "not yet"],
					[
						"Change pending",
						output.freshness.publishPending ? "yes, publishes within a minute" : "no",
					],
				]),
				...(output.components.length === 0
					? [doc.text("No components yet.")]
					: [
							doc.table(
								["Component", "Group", "Status", "Monitor", "Id"],
								output.components.map((c) => [
									c.name,
									c.group ?? "-",
									c.status,
									c.monitorId ?? "-",
									c.id,
								]),
							),
						]),
				...(output.activeIncidents.length === 0
					? [doc.text("No open incidents or maintenance.")]
					: [
							doc.table(
								["Title", "Kind", "Status", "Impact", "Published", "Id"],
								output.activeIncidents.map((i) => [
									i.title,
									i.kind,
									i.status,
									i.impact,
									i.published ? "yes" : "draft",
									i.id,
								]),
							),
						]),
			],
		}),
	})

	server.define({
		name: "create_status_page_incident",
		title: "Create Status Page Incident",
		description:
			"Open a customer-facing incident on a status page with its first public update (`message`). `components` names the affected components; `impact` sets how hard it hits them. Starts as an unpublished draft unless publish=true: everything here is public text your customers read. Separate from internal alert incidents.",
		parameters: Schema.Struct({
			page: P.text("The page's slug, name or id"),
			title: P.text("Public title, e.g. `Elevated API errors`"),
			message: P.text("The first public update, written for customers"),
			impact: P.optionalOneOf(
				StatusPageIncidentImpact.literals,
				"How hard it hits the components (default minor)",
			),
			status: P.optionalOneOf(INCIDENT_STATUSES, "Where the response stands (default investigating)"),
			components: P.optionalList("Affected components, by name or id (get_status_page lists them)"),
			publish: publishParameter,
		}),
		output: StatusPageIncidentMutationOutput,
		hints: MUTATION_HINTS,
		phrases: ["Opening a status page incident"],
		handler: Effect.fn("McpTool.createStatusPageIncident")(function* (params) {
			const tool = "create_status_page_incident"
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService
			const page = yield* resolvePage(tool, tenant.orgId, params.page)
			const components = yield* pageComponents(tool, tenant.orgId, page.id)
			const componentIds = yield* resolveComponents(components, params.components ?? [])
			const created = yield* service
				.createIncident(tenant.orgId, page.id, {
					kind: "incident",
					title: params.title,
					impact: params.impact ?? "minor",
					status: params.status ?? "investigating",
					body: params.message,
					componentIds,
					published: params.publish === true,
					source: "mcp",
					createdBy: tenant.userId,
				})
				.pipe(Effect.mapError(toMcpError(tool)))
			return { action: "created" as const, incident: toIncidentRow(created) }
		}),
		render: (output) => renderIncident("Status page incident opened", output),
	})

	server.define({
		name: "post_status_page_update",
		title: "Post Status Page Update",
		description:
			"Post the next public update on a status page incident or maintenance and move it to `status`. Pass publish=true to also publish a draft. To close an incident use resolve_status_page_incident. The message is public text your customers read.",
		parameters: Schema.Struct({
			incident: P.text("The incident's id (sti_… or its UUID; get_status_page lists open ones)"),
			message: P.text("The public update, written for customers"),
			status: P.oneOf(
				["investigating", "identified", "monitoring", "scheduled", "in_progress"] as const,
				"Incidents: investigating, identified, monitoring. Maintenance: scheduled, in_progress",
			),
			impact: P.optionalOneOf(StatusPageIncidentImpact.literals, "A new impact; omit to keep it"),
			components: P.optionalList("Replaces the affected components, by name or id"),
			publish: P.optionalFlag("true publishes a draft along with this update"),
		}),
		output: StatusPageIncidentMutationOutput,
		hints: MUTATION_HINTS,
		phrases: ["Posting a status page update"],
		handler: Effect.fn("McpTool.postStatusPageUpdate")(function* (params) {
			const tool = "post_status_page_update"
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService
			const incidentId = yield* decodeIncidentId(params.incident)
			const current = yield* service
				.getIncident(tenant.orgId, incidentId)
				.pipe(Effect.mapError(toMcpError(tool)))
			const componentIds =
				params.components === undefined
					? undefined
					: yield* resolveComponents(
							yield* pageComponents(tool, tenant.orgId, current.pageId),
							params.components,
						)
			const posted = yield* service
				.postUpdate(tenant.orgId, incidentId, {
					status: params.status,
					body: params.message,
					...(params.impact === undefined ? undefined : { impact: params.impact }),
					...(componentIds === undefined ? undefined : { componentIds }),
					source: "mcp",
					createdBy: tenant.userId,
					// One write: a failure leaves neither the update nor the publish, so a retry cannot double post.
					publish: params.publish === true,
				})
				.pipe(Effect.mapError(toMcpError(tool)))
			return { action: "updated" as const, incident: toIncidentRow(posted) }
		}),
		render: (output) => renderIncident("Status page update posted", output),
	})

	server.define({
		name: "resolve_status_page_incident",
		title: "Resolve Status Page Incident",
		description:
			"Close a status page incident (or complete a maintenance) with a final public update. The message is public text your customers read.",
		parameters: Schema.Struct({
			incident: P.text("The incident's id (sti_… or its UUID)"),
			message: P.text("The closing public update, e.g. what was fixed"),
			publish: P.optionalFlag("true publishes a draft along with its closing update"),
		}),
		output: StatusPageIncidentMutationOutput,
		hints: MUTATION_HINTS,
		phrases: ["Resolving a status page incident"],
		handler: Effect.fn("McpTool.resolveStatusPageIncident")(function* (params) {
			const tool = "resolve_status_page_incident"
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService
			const incidentId = yield* decodeIncidentId(params.incident)
			const current = yield* service
				.getIncident(tenant.orgId, incidentId)
				.pipe(Effect.mapError(toMcpError(tool)))
			const status: StatusPageIncidentStatus = current.kind === "maintenance" ? "completed" : "resolved"
			const updated = yield* service
				.postUpdate(tenant.orgId, incidentId, {
					status,
					body: params.message,
					source: "mcp",
					createdBy: tenant.userId,
					publish: params.publish === true,
				})
				.pipe(Effect.mapError(toMcpError(tool)))
			return { action: "resolved" as const, incident: toIncidentRow(updated) }
		}),
		render: (output) => renderIncident("Status page incident resolved", output),
	})

	server.define({
		name: "schedule_status_page_maintenance",
		title: "Schedule Status Page Maintenance",
		description:
			"Announce planned maintenance on a status page for a window (`starts_at` to `ends_at`, UTC). The named components show `maintenance` while it is in progress. Starts as an unpublished draft unless publish=true: the message is public text your customers read.",
		parameters: Schema.Struct({
			page: P.text("The page's slug, name or id"),
			title: P.text("Public title, e.g. `Database upgrade`"),
			message: P.text("What will happen and what customers may notice"),
			starts_at: utcTime("When it starts"),
			ends_at: utcTime("When it ends"),
			impact: P.optionalOneOf(StatusPageIncidentImpact.literals, "Expected impact (default none)"),
			components: P.optionalList("Components under maintenance, by name or id"),
			publish: publishParameter,
		}),
		output: StatusPageIncidentMutationOutput,
		hints: MUTATION_HINTS,
		phrases: ["Scheduling maintenance"],
		handler: Effect.fn("McpTool.scheduleStatusPageMaintenance")(function* (params) {
			const tool = "schedule_status_page_maintenance"
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService
			const page = yield* resolvePage(tool, tenant.orgId, params.page)
			const components = yield* pageComponents(tool, tenant.orgId, page.id)
			const componentIds = yield* resolveComponents(components, params.components ?? [])
			const created = yield* service
				.createIncident(tenant.orgId, page.id, {
					kind: "maintenance",
					title: params.title,
					impact: params.impact ?? "none",
					status: "scheduled",
					body: params.message,
					componentIds,
					published: params.publish === true,
					scheduledStart: parseWarehouseDateTime(params.starts_at),
					scheduledEnd: parseWarehouseDateTime(params.ends_at),
					source: "mcp",
					createdBy: tenant.userId,
				})
				.pipe(Effect.mapError(toMcpError(tool)))
			return { action: "scheduled" as const, incident: toIncidentRow(created) }
		}),
		render: (output) => renderIncident("Maintenance scheduled", output),
	})

	server.define({
		name: "get_status_page_config",
		title: "Get Status Page Config",
		description:
			"One status page's settings, theme and ordered components as a JSON document (no incidents, break-glass token or publish state). Edit it and pass it to apply_status_page_config to change the page in one write. Same document as GET /v2/status_pages/{id}/config.",
		parameters: Schema.Struct({
			page: P.text("The page's slug, name or id (list_status_pages lists them)"),
		}),
		output: GetStatusPageConfigOutput,
		hints: { readOnly: true, destructive: false, idempotent: true },
		phrases: ["Reading a status page config"],
		handler: Effect.fn("McpTool.getStatusPageConfig")(function* (params) {
			const tool = "get_status_page_config"
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService
			const page = yield* resolvePage(tool, tenant.orgId, params.page)
			const config = yield* service
				.getConfig(tenant.orgId, page.id)
				.pipe(Effect.mapError(toMcpError(tool)))
			return { page: toPageRow(page), config }
		}),
		render: (output) => ({
			title: `Status page config: ${output.page.name}`,
			notices: [
				"apply_status_page_config replaces the page with an edited copy: keep a component's id to update it, drop the id to add one, leave it out to delete it. Order is display order. Keep the `version` key: the apply is refused if the config changed since this read.",
			],
			blocks: [doc.code("json", JSON.stringify(encodeConfig(output.config), null, 2))],
		}),
	})

	server.define({
		name: "apply_status_page_config",
		title: "Apply Status Page Config",
		description:
			"Replace a status page with a config document from get_status_page_config, in one write that fully applies or not at all. Components with an `id` are updated, without one created, and left out deleted; list order is display order; omitted optional fields take their defaults; unknown keys are refused. The document's `version` guards the write: if the config changed since it was read, nothing is applied and you must read it again. Only org admins may call it, and the result is public on the page.",
		parameters: Schema.Struct({
			page: P.text("The page's slug, name or id"),
			config: P.json(
				StatusPageConfig,
				"The whole page document, as returned by get_status_page_config, edited. Keys it does not define are refused",
			),
			if_version: P.optionalText(
				"The config `version` the document was read with. Defaults to the document's `version`; the apply is refused if the config changed since",
			),
		}),
		rejectUnknownKeys: true,
		output: ApplyStatusPageConfigOutput,
		hints: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
		phrases: ["Applying a status page config"],
		handler: Effect.fn("McpTool.applyStatusPageConfig")(function* (params) {
			const tool = "apply_status_page_config"
			const tenant = yield* CurrentMcpTenant
			yield* requireAdmin(
				tenant.roles,
				() =>
					new McpUnavailableError({
						message: `${tool} changes a public status page, which only org admins may do. Ask an admin, or edit it in Maple under Status pages.`,
						capability: "org_admin",
					}),
			)
			const service = yield* StatusPagesService
			const page = yield* resolvePage(tool, tenant.orgId, params.page)
			const { config, changes } = yield* service
				.applyConfig(tenant.orgId, page.id, params.config, tenant.userId, {
					ifVersion: params.if_version ?? params.config.version,
				})
				.pipe(Effect.mapError(toMcpError(tool)))
			const audit = yield* AuditLogService
			// Nothing written, nothing to audit.
			if (hasStatusPageConfigChanges(changes))
				yield* audit.record({
					orgId: tenant.orgId,
					...auditAttribution(tenant, yield* CurrentAuditActor),
					action: "status_page.config_applied",
					resourceId: page.id,
					metadata: {
						name: config.name,
						fields_changed: changes.fields.join(","),
						components_created: changes.created.length,
						components_updated: changes.updated.length,
						components_deleted: changes.deleted.length,
						components_reordered: changes.reordered,
					},
				})
			const applied = yield* service.get(tenant.orgId, page.id).pipe(Effect.mapError(toMcpError(tool)))
			return { page: toPageRow(applied), config, changes }
		}),
		render: (output) => {
			const { fields, created, updated, deleted, reordered } = output.changes
			const unchanged =
				fields.length === 0 &&
				created.length === 0 &&
				updated.length === 0 &&
				deleted.length === 0 &&
				!reordered
			const list = (names: ReadonlyArray<string>) => (names.length === 0 ? undefined : names.join(", "))
			return {
				title: `Status page config applied: ${output.page.name}`,
				notices: unchanged
					? ["Nothing changed: the document matched the page."]
					: ["The change publishes to the public page within a minute."],
				blocks: [
					doc.fields([
						["Fields changed", list(fields)],
						["Components created", list(created)],
						["Components updated", list(updated)],
						["Components deleted", list(deleted)],
						["Order changed", reordered ? "yes" : undefined],
					]),
				],
				next: [
					doc.next("get_status_page", { page: output.page.slug }, "the page as visitors see it"),
				],
			}
		},
	})
}
