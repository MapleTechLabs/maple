/**
 * Status pages: what the org's customers see about its health. Anyone may read them and run
 * incidents, like the REST routes; an agent's incident starts as a draft unless it asks to publish,
 * because every update is public text on the customer's page. Admins and engineers set pages up:
 * an agent's new page is a draft until publish_status_page, and its custom domain has its own
 * DNS lifecycle (docs/status-page-custom-domains.md).
 */
import { Clock, Effect, Schema, Array as Arr, String as Str } from "effect"
import {
	StatusPageIncidentMutationOutput,
	type CreateStatusPageOutput,
	type PublishStatusPageOutput,
	type SetStatusPageDomainOutput,
	type StatusPageDetail,
	type StatusPageDomainRow,
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
import type { StatusPageCustomDomainRow } from "@maple/db/tables"
import {
	StatusPageIncidentId,
	StatusPageIncidentImpact,
	type OrgId,
	type StatusPageComponentId,
	type StatusPageId,
	type StatusPageIncidentStatus,
} from "@maple/primitives"
import {
	isActiveIncident,
	normalizeCustomDomain,
	overallStatus,
	pageFreshness,
	slugFromName,
	StatusPageSlug,
} from "@maple/domain/status-page"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { auditAttribution, originMetadata } from "@maple/backend/services/audit/audit-access"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import * as Policy from "@maple/domain/policy"
import { stringifyJsonPretty } from "../lib/json"
import { StatusPagesService } from "@maple/backend/services/status-pages/StatusPagesService"
import {
	StatusPageCustomDomainsService,
	type StatusPageCustomDomainView,
} from "@maple/backend/services/status-pages/StatusPageCustomDomainsService"
import { StatusPageSnapshotBuilder } from "@maple/backend/services/status-pages/StatusPageSnapshotBuilder"
import { McpInvalidInputError, McpQueryError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../tenant"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

/** What setting or checking a custom domain can fail with. */
type StatusPageCustomDomainError = Effect.Error<
	| ReturnType<StatusPageCustomDomainsService["Service"]["set"]>
	| ReturnType<StatusPageCustomDomainsService["Service"]["check"]>
>

const MUTATION_HINTS = { readOnly: false, destructive: false, idempotent: false, openWorld: true } as const
const encodeConfig = Schema.encodeSync(StatusPageConfig)
const matchesSlug = Schema.is(StatusPageSlug)
/** Not a type guard: a refused slug is still a string to quote back. */
const isSlug = (value: string): boolean => matchesSlug(value)

const iso = (ms: number) => new Date(ms).toISOString()
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms))

/** Service failures as tool errors: a missing or invalid reference is the caller's to fix. */
const toMcpError =
	(tool: string) =>
	(error: {
		readonly _tag: string
		readonly message: string
	}): McpInvalidInputError | McpQueryError | McpUnavailableError => {
		switch (error._tag) {
			case "@maple/http/errors/StatusPageNotFoundError":
			case "@maple/backend/status-pages/StatusPageGoneError":
				return new McpInvalidInputError({
					message: "No such status page. get_status_page without `page` lists them.",
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
			case "@maple/http/errors/StatusPageCustomDomainTakenError":
				return new McpInvalidInputError({ message: error.message, parameter: "domain" })
			case "@maple/http/errors/StatusPageCustomDomainsUnavailableError":
				return new McpUnavailableError({
					message: "Custom domains are not available on this Maple deployment.",
					capability: "status_page_custom_domains",
				})
			case "@maple/http/errors/StatusPageConflictError":
				return new McpInvalidInputError({
					message: `${error.message} Nothing was applied. Call get_status_page with include_config=true again and redo the edit on the fresh document; applying the old one would undo the other change.`,
					parameter: "if_version",
				})
			default:
				return new McpQueryError({ message: error.message, pipeName: tool, cause: error })
		}
	}

const toPageRow = (page: StatusPageRecord): typeof StatusPageRow.Type => ({
	id: encodePublicId(PublicIdPrefixes.statusPage, page.id),
	name: page.name,
	slug: page.slug,
	autoIncidents: page.autoIncidents,
	visibility: page.visibility,
	draft: page.draft,
	revision: page.revision,
	publishedRevision: page.publishedRevision,
	publishedAt: isoOrNull(page.publishedAt),
	lastPublishError: page.lastPublishError,
})

const toDomainRow = (domain: StatusPageCustomDomainRow): typeof StatusPageDomainRow.Type => ({
	hostname: domain.hostname,
	status: domain.status,
	dnsRecords: domain.dnsRecords,
	lastError: domain.lastError,
	lastCheckedAt: isoOrNull(domain.lastCheckedAt),
	activatedAt: isoOrNull(domain.activatedAt),
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
		autoComplete: incident.autoComplete,
		componentIds: Arr.map(incident.componentIds, (id) =>
			encodePublicId(PublicIdPrefixes.statusPageComponent, id),
		),
		latestUpdate:
			latest === undefined
				? null
				: { status: latest.status, body: latest.body, at: iso(latest.createdAt) },
		updateCount: incident.updates.length,
	}
}

/** Setting pages up is for admins and engineers, as on the REST routes (`status_pages:edit`). */
const requireEditor = (roles: ReadonlyArray<string>, tool: string, action: string) =>
	Policy.check(
		roles,
		"status_pages:edit",
		() =>
			new McpUnavailableError({
				message: `${tool} ${action}, which only org admins and engineers may do. Ask an admin or engineer, or do it in Maple under Status pages.`,
				capability: "org_admin",
			}),
	)

/** The page entries the REST routes write, under the same actions. */
const auditPage = Effect.fnUntraced(function* (
	action:
		| "status_page.created"
		| "status_page.published"
		| "status_page.custom_domain_set"
		| "status_page.custom_domain_removed",
	pageId: StatusPageId,
	metadata: Readonly<Record<string, string | number | null>>,
) {
	const tenant = yield* CurrentMcpTenant
	const audit = yield* AuditLogService
	const actor = yield* CurrentAuditActor
	yield* audit.record({
		orgId: tenant.orgId,
		...auditAttribution(tenant, actor),
		action,
		resourceId: pageId,
		metadata: { ...metadata, ...originMetadata(tenant.turnOrigin) },
	})
})

/** The same resource entries the REST routes write, so MCP edits show up per incident. */
const auditIncidentCreated = Effect.fnUntraced(function* (incident: StatusPageIncidentRecord) {
	const tenant = yield* CurrentMcpTenant
	const audit = yield* AuditLogService
	const actor = yield* CurrentAuditActor
	yield* audit.record({
		orgId: tenant.orgId,
		...auditAttribution(tenant, actor),
		action: "status_page_incident.created",
		resourceId: incident.id,
		metadata: {
			title: incident.title,
			kind: incident.kind,
			page_id: incident.pageId,
			published: incident.published,
			...originMetadata(tenant.turnOrigin),
		},
	})
})

const auditUpdatePosted = Effect.fnUntraced(function* (incident: StatusPageIncidentRecord) {
	const tenant = yield* CurrentMcpTenant
	const audit = yield* AuditLogService
	const actor = yield* CurrentAuditActor
	yield* audit.record({
		orgId: tenant.orgId,
		...auditAttribution(tenant, actor),
		action: "status_page_incident.update_posted",
		resourceId: incident.id,
		metadata: {
			status: incident.status,
			page_id: incident.pageId,
			active: isActiveIncident(incident),
			...originMetadata(tenant.turnOrigin),
		},
	})
})

/** Whether the incident's page is still a draft, which keeps everything on it private. */
const pageIsDraft = Effect.fnUntraced(function* (tool: string, orgId: OrgId, pageId: StatusPageId) {
	const page = yield* (yield* StatusPagesService).get(orgId, pageId).pipe(Effect.mapError(toMcpError(tool)))
	return page.draft
})

/** A page by its id, REST id (`stp_…`), slug or exact name. */
const resolvePage = Effect.fnUntraced(function* (tool: string, orgId: OrgId, ref: string) {
	const service = yield* StatusPagesService
	const pages = yield* service.list(orgId).pipe(Effect.mapError(toMcpError(tool)))
	const value = Str.trim(ref)
	const id = decodePublicId(PublicIdPrefixes.statusPage, value) ?? value
	const matches = Arr.filter(pages, (page) => page.id === id || page.slug === value || page.name === value)
	const [page] = matches
	if (page === undefined) {
		return yield* new McpInvalidInputError({
			message: `No status page "${ref}". get_status_page without \`page\` lists them.`,
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
	const value = Str.trim(ref)
	return Schema.decodeEffect(StatusPageIncidentId)(
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
		const value = Str.trim(ref)
		const id = decodePublicId(PublicIdPrefixes.statusPageComponent, value) ?? value
		const found = components.find((component) => component.id === id || component.name === value)
		return found === undefined
			? Effect.fail(
					new McpInvalidInputError({
						message: `No component "${ref}" on this page. Its components: ${
							Arr.join(
								Arr.map(components, (c) => c.name),
								", ",
							) || "none"
						}.`,
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
		notices: output.pageDraft
			? [
					"The page is a draft, so nothing on it is public, this incident included. publish_status_page publishes it once the user wants it public.",
				]
			: incident.published
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
				[
					"When the window ends",
					incident.kind === "maintenance"
						? incident.autoComplete
							? "completes on its own"
							: "stays in progress until someone completes it"
						: undefined,
				],
				["Latest update", incident.latestUpdate?.body],
			]),
		],
		next: [doc.next("get_status_page", { page: incident.pageId }, "the page with this incident")],
	}
}

const publishParameter = P.optionalFlag(
	"true puts it on the public page now. Default false: a draft a person reviews and publishes",
)

const UPDATE_STATUSES = [
	"investigating",
	"identified",
	"monitoring",
	"resolved",
	"scheduled",
	"in_progress",
	"completed",
] as const

/** `resolved` and `completed` both close: the kind decides which one the service stores. */
const statusForKind = (
	kind: StatusPageIncidentRecord["kind"],
	status: (typeof UPDATE_STATUSES)[number],
): StatusPageIncidentStatus =>
	status === "resolved" || status === "completed"
		? kind === "maintenance"
			? "completed"
			: "resolved"
		: status

const isClosingStatus = (status: StatusPageIncidentStatus) => status === "resolved" || status === "completed"

const renderPageList = (pages: ReadonlyArray<typeof StatusPageRow.Type>) => ({
	title: "Status pages",
	...(pages.length === 0
		? {
				empty: {
					message: "This organization has no status pages.",
					hints: [
						"create_status_page creates one as a draft, or create it in Maple under Status pages.",
					],
				},
			}
		: undefined),
	blocks:
		pages.length === 0
			? []
			: [
					doc.table(
						["Name", "Slug", "Id", "Published", "Publish error"],
						Arr.map(pages, (page) => [
							page.name,
							page.slug,
							page.id,
							page.draft
								? "draft, not public"
								: page.publishedAt === null
									? "not yet"
									: page.publishedRevision < page.revision
										? `${page.publishedAt} (change pending)`
										: page.publishedAt,
							page.lastPublishError ?? "-",
						]),
					),
				],
	next: Arr.map(pages.slice(0, 3), (page) =>
		doc.next("get_status_page", { page: page.slug }, `${page.name}'s components and incidents`),
	),
})

const renderPageDetail = (page: typeof StatusPageDetail.Type, config: StatusPageConfig | undefined) => ({
	title: `Status page: ${page.name}`,
	notices: [
		// No suggested call: every follow-up needs a public message only the user can word.
		...(Arr.some(page.activeIncidents, (incident) => isActiveIncident(incident))
			? [
					"To update an open incident, call post_status_page_update (incident, status, message) with wording the user approves; status=resolved closes it.",
				]
			: []),
		...(page.freshness.state === "delayed"
			? [
					page.freshness.updatedAt === null
						? "Live checks are delayed: none of the page's monitors has reported in the last two days."
						: `Live checks are delayed: the page's monitors last reported at ${page.freshness.updatedAt}.`,
				]
			: []),
		...(page.lastPublishError === null
			? []
			: [`The last publish failed: ${page.lastPublishError}. The next minutely publish retries.`]),
		...(page.customDomain === undefined || page.customDomain.status === "active"
			? []
			: [
					`The custom domain ${page.customDomain.hostname} is not live yet (${page.customDomain.status})${
						page.customDomain.lastError === null ? "" : `: ${page.customDomain.lastError}`
					}. set_status_page_domain with the same domain lists its DNS records and checks them now.`,
				]),
		...(config === undefined
			? []
			: [
					"apply_status_page_config replaces the page with an edited copy of the config below: keep a component's id to update it, drop the id to add one, leave it out to delete it. Order is display order. Keep the `version` key: the apply is refused if the config changed since this read.",
				]),
	],
	blocks: [
		doc.fields([
			["Slug", page.slug],
			["Id", page.id],
			["Overall", page.overallStatus],
			["Published", page.draft ? "draft, not public" : (page.publishedAt ?? "not yet")],
			["Change pending", page.freshness.publishPending ? "yes, publishes within a minute" : "no"],
			[
				"Custom domain",
				page.customDomain === undefined
					? undefined
					: `${page.customDomain.hostname} (${page.customDomain.status})`,
			],
		]),
		...(page.components.length === 0
			? [doc.text("No components yet.")]
			: [
					doc.table(
						["Component", "Group", "Status", "Monitor", "Id"],
						Arr.map(page.components, (c) => [
							c.name,
							c.group ?? "-",
							c.status,
							c.monitorId ?? "-",
							c.id,
						]),
					),
				]),
		...(page.activeIncidents.length === 0
			? [doc.text("No open incidents or maintenance.")]
			: [
					doc.table(
						["Title", "Kind", "Status", "Impact", "Published", "Id"],
						Arr.map(page.activeIncidents, (i) => [
							i.title,
							i.kind,
							i.status,
							i.impact,
							i.published ? "yes" : "draft",
							i.id,
						]),
					),
				]),
		...(config === undefined ? [] : [doc.code("json", stringifyJsonPretty(encodeConfig(config)) ?? "")]),
	],
})

/** One page as its visitors see it, scoped to the caller's org by `resolvePage`. */
const readPageDetail = Effect.fnUntraced(function* (tool: string, orgId: OrgId, page: StatusPageRecord) {
	const service = yield* StatusPagesService
	const builder = yield* StatusPageSnapshotBuilder
	const customDomains = yield* StatusPageCustomDomainsService
	const nowMs = yield* Clock.currentTimeMillis
	const snapshot = yield* builder.build(page.id, nowMs).pipe(Effect.mapError(toMcpError(tool)))
	const { domain } = yield* customDomains.get(orgId, page.id).pipe(Effect.mapError(toMcpError(tool)))
	const records = yield* pageComponents(tool, orgId, page.id)
	const incidents = yield* service.listIncidents(orgId, page.id).pipe(Effect.mapError(toMcpError(tool)))
	// Answering means Maple is up, so this is the probe side of freshness only, scoped to this org.
	const probesSeenAt = yield* builder.probesSeenAt(nowMs, orgId).pipe(Effect.mapError(toMcpError(tool)))
	const monitored = Arr.some(snapshot.components, (component) => component.monitored)
	// No recent probe at all is the most delayed a monitored page can be, not "live now".
	const freshness =
		monitored && probesSeenAt === null
			? { _tag: "delayed" as const, updatedAt: null }
			: pageFreshness({ snapshot, heartbeat: { at: nowMs, probesSeenAt }, nowMs })
	return {
		...toPageRow(page),
		...(domain === null ? undefined : { customDomain: toDomainRow(domain) }),
		overallStatus: overallStatus(snapshot),
		components: Arr.map(snapshot.components, (component) => {
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
		activeIncidents: Arr.map(incidents, toIncidentRow),
		freshness: {
			state: freshness._tag,
			updatedAt: freshness.updatedAt === null ? null : iso(freshness.updatedAt),
			// A draft is never published, so nothing is pending for it.
			publishPending: !page.draft && page.publishedRevision < page.revision,
		},
	}
})

const opensOnlyParameter = (name: string) =>
	new McpInvalidInputError({
		message: `\`${name}\` only applies when opening an incident or maintenance (no \`incident\`). Drop it, or drop \`incident\` to open a new one.`,
		parameter: name,
	})

export function registerStatusPageTools(server: McpToolRegistrar) {
	server.define({
		name: "get_status_page",
		title: "Get Status Page",
		description:
			"The org's public status pages. Without `page`: every page with its slug and publish state. With `page`: that page as visitors see it, each component's status (worst of its uptime monitor, manual override and published incidents), the overall banner, open incidents and maintenance (drafts included, marked), and whether its live checks are fresh. include_config=true adds the page's settings, theme and components as the JSON document apply_status_page_config takes.",
		parameters: Schema.Struct({
			page: P.optionalText("The page's slug, name or id. Omit to list every page"),
			include_config: P.optionalFlag(
				"true adds the editable config document (needs `page`). Same document as GET /v2/status_pages/{id}/config",
			),
		}),
		hints: { readOnly: true, destructive: false, idempotent: true },
		// One page's detail lists its incidents, drafts included.
		scopeFamily: ["status_pages", "status_page_incidents"],
		phrases: ["Reading status pages"],
		handler: Effect.fn("McpTool.getStatusPage")(function* (params) {
			const tool = "get_status_page"
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService
			if (params.page === undefined) {
				if (params.include_config === true) {
					return yield* new McpInvalidInputError({
						message: "include_config needs `page`: the config document is per page.",
						parameter: "include_config",
					})
				}
				const pages = yield* service.list(tenant.orgId).pipe(Effect.mapError(toMcpError(tool)))
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": pages.length })
				return { pages: Arr.map(pages, toPageRow) }
			}
			const page = yield* resolvePage(tool, tenant.orgId, params.page)
			const detail = yield* readPageDetail(tool, tenant.orgId, page)
			if (params.include_config !== true) return { page: detail }
			const config = yield* service
				.getConfig(tenant.orgId, page.id)
				.pipe(Effect.mapError(toMcpError(tool)))
			return { page: detail, config }
		}),
		render: (output) =>
			output.page === undefined
				? renderPageList(output.pages ?? [])
				: renderPageDetail(output.page, output.config),
	})

	server.define({
		name: "post_status_page_update",
		title: "Post Status Page Update",
		description:
			"Write to a status page's incidents and maintenance, all public text your customers read. Without `incident`: opens a new incident on `page` with `title` and `message` as its first update, or announces maintenance when `starts_at` and `ends_at` are given. With `incident`: posts the next update and moves it to `status`; status=resolved (or completed) closes it. New ones start as unpublished drafts unless publish=true. Separate from internal alert incidents.",
		parameters: Schema.Struct({
			incident: P.optionalText(
				"The incident's id (sti_… or its UUID; get_status_page lists open ones). Omit to open a new one",
			),
			message: P.text("The public update, written for customers (up to 20,000 characters)"),
			status: P.optionalOneOf(
				UPDATE_STATUSES,
				"Incidents: investigating, identified, monitoring, resolved. Maintenance: scheduled, in_progress, completed. Required on an existing incident; a new incident starts investigating, new maintenance scheduled",
			),
			page: P.optionalText("Opening only: the page's slug, name or id"),
			title: P.optionalText(
				"Opening only: public title, e.g. `Elevated API errors` or `Database upgrade`",
			),
			starts_at: P.optionalTimestamp("Opening maintenance only: when it starts"),
			ends_at: P.optionalTimestamp(
				"Opening maintenance only: when it ends. It moves to in_progress at the start and completed at the end on its own",
			),
			auto_complete: P.optionalFlag(
				"Opening maintenance only: false keeps it in_progress past `ends_at` until someone posts completed. Default true",
			),
			impact: P.optionalOneOf(
				StatusPageIncidentImpact.literals,
				"How hard it hits the components (new incident default minor, new maintenance none; omit on an update to keep it)",
			),
			components: P.optionalList(
				"Affected components, by name or id (get_status_page lists them). On an update it replaces the list",
			),
			publish: publishParameter,
		}),
		hints: MUTATION_HINTS,
		scopeFamily: "status_page_incidents",
		phrases: ["Posting a status page update"],
		handler: Effect.fn("McpTool.postStatusPageUpdate")(function* (params) {
			const tool = "post_status_page_update"
			const tenant = yield* CurrentMcpTenant
			const service = yield* StatusPagesService

			if (params.incident === undefined) {
				if (params.page === undefined) {
					return yield* new McpInvalidInputError({
						message:
							"Pass `page` to open a new incident or maintenance, or `incident` to update an existing one.",
						parameter: "page",
					})
				}
				if (params.title === undefined) {
					return yield* new McpInvalidInputError({
						message: "Opening an incident or maintenance needs a public `title`.",
						parameter: "title",
					})
				}
				if ((params.starts_at === undefined) !== (params.ends_at === undefined)) {
					return yield* new McpInvalidInputError({
						message:
							"Maintenance needs both `starts_at` and `ends_at`; an incident takes neither.",
						parameter: params.starts_at === undefined ? "starts_at" : "ends_at",
					})
				}
				const kind = params.starts_at === undefined ? ("incident" as const) : ("maintenance" as const)
				const status =
					params.status === undefined
						? kind === "incident"
							? ("investigating" as const)
							: ("scheduled" as const)
						: statusForKind(kind, params.status)
				const page = yield* resolvePage(tool, tenant.orgId, params.page)
				const components = yield* pageComponents(tool, tenant.orgId, page.id)
				const componentIds = yield* resolveComponents(components, params.components ?? [])
				const created = yield* service
					.createIncident(tenant.orgId, page.id, {
						kind,
						title: params.title,
						impact: params.impact ?? (kind === "incident" ? "minor" : "none"),
						status,
						body: params.message,
						componentIds,
						published: params.publish === true,
						...(params.starts_at === undefined || params.ends_at === undefined
							? undefined
							: {
									scheduledStart: parseWarehouseDateTime(params.starts_at),
									scheduledEnd: parseWarehouseDateTime(params.ends_at),
								}),
						...(params.auto_complete === undefined
							? undefined
							: { autoComplete: params.auto_complete }),
						source: "mcp",
						createdBy: tenant.userId,
					})
					.pipe(Effect.mapError(toMcpError(tool)))
				yield* auditIncidentCreated(created)
				return {
					action: kind === "incident" ? ("created" as const) : ("scheduled" as const),
					incident: toIncidentRow(created),
					pageDraft: page.draft,
				}
			}

			if (params.page !== undefined) return yield* opensOnlyParameter("page")
			if (params.title !== undefined) return yield* opensOnlyParameter("title")
			if (params.starts_at !== undefined) return yield* opensOnlyParameter("starts_at")
			if (params.ends_at !== undefined) return yield* opensOnlyParameter("ends_at")
			if (params.auto_complete !== undefined) return yield* opensOnlyParameter("auto_complete")
			const requestedStatus = params.status
			if (requestedStatus === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"An update needs a `status`: investigating, identified, monitoring or resolved for an incident; scheduled, in_progress or completed for maintenance.",
					parameter: "status",
				})
			}
			const incidentId = yield* decodeIncidentId(params.incident)
			const current = yield* service
				.getIncident(tenant.orgId, incidentId)
				.pipe(Effect.mapError(toMcpError(tool)))
			const status = statusForKind(current.kind, requestedStatus)
			const requested = params.components
			const componentIds =
				requested === undefined
					? undefined
					: yield* pageComponents(tool, tenant.orgId, current.pageId).pipe(
							Effect.flatMap((components) => resolveComponents(components, requested)),
						)
			const posted = yield* service
				.postUpdate(tenant.orgId, incidentId, {
					status,
					body: params.message,
					...(params.impact === undefined ? undefined : { impact: params.impact }),
					...(componentIds === undefined ? undefined : { componentIds }),
					source: "mcp",
					createdBy: tenant.userId,
					// One write: a failure leaves neither the update nor the publish, so a retry cannot double post.
					publish: params.publish === true,
				})
				.pipe(Effect.mapError(toMcpError(tool)))
			yield* auditUpdatePosted(posted)
			return {
				action: isClosingStatus(status) ? ("resolved" as const) : ("updated" as const),
				incident: toIncidentRow(posted),
				pageDraft: yield* pageIsDraft(tool, tenant.orgId, posted.pageId),
			}
		}),
		render: (output) =>
			renderIncident(
				output.action === "created"
					? "Status page incident opened"
					: output.action === "scheduled"
						? "Maintenance scheduled"
						: output.action === "resolved"
							? "Status page incident resolved"
							: "Status page update posted",
				output,
			),
	})

	server.define({
		name: "apply_status_page_config",
		title: "Apply Status Page Config",
		description:
			"Replace a status page with the config document get_status_page returns with include_config=true, in one write that fully applies or not at all. Components with an `id` are updated, without one created, and left out deleted; list order is display order; omitted optional fields take their defaults; unknown keys are refused. The document's `version` guards the write: if the config changed since it was read, nothing is applied and you must read it again. Only org admins and engineers may call it, and the result is public on the page.",
		parameters: Schema.Struct({
			page: P.text("The page's slug, name or id"),
			config: P.json(
				StatusPageConfig,
				"The whole page document, as get_status_page returns it with include_config=true, edited. Keys it does not define are refused",
			),
			if_version: P.optionalText(
				"The config `version` the document was read with. Defaults to the document's `version`; the apply is refused if the config changed since",
			),
		}),
		rejectUnknownKeys: true,
		hints: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
		scopeFamily: "status_pages",
		phrases: ["Applying a status page config"],
		handler: Effect.fn("McpTool.applyStatusPageConfig")(function* (params) {
			const tool = "apply_status_page_config"
			const tenant = yield* CurrentMcpTenant
			yield* requireEditor(tenant.roles, tool, "changes a public status page")
			const service = yield* StatusPagesService
			const page = yield* resolvePage(tool, tenant.orgId, params.page)
			// Who can read the page has its own permission, checked as the HTTP routes check it. The
			// page password is not in the document, so visibility is the only such field here.
			const visibility = params.config.visibility
			if (visibility !== undefined && visibility !== page.visibility)
				yield* Policy.check(
					tenant.roles,
					"status_pages:access",
					(denial) =>
						new McpUnavailableError({
							message: `${tool} would change who can read the page. ${denial.message} Leave \`visibility\` as it is, or ask someone who can.`,
							capability: "org_admin",
						}),
				)
			const { config, changes } = yield* service
				.applyConfig(tenant.orgId, page.id, params.config, tenant.userId, {
					ifVersion: params.if_version ?? params.config.version,
				})
				.pipe(Effect.mapError(toMcpError(tool)))
			const audit = yield* AuditLogService
			if (hasStatusPageConfigChanges(changes)) {
				const actor = yield* CurrentAuditActor
				yield* audit.record({
					orgId: tenant.orgId,
					...auditAttribution(tenant, actor),
					action: "status_page.config_applied",
					resourceId: page.id,
					metadata: {
						name: config.name,
						fields_changed: Arr.join(changes.fields, ","),
						components_created: changes.created.length,
						components_updated: changes.updated.length,
						components_deleted: changes.deleted.length,
						components_reordered: changes.reordered,
						...originMetadata(tenant.turnOrigin),
					},
				})
			}
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
			const list = (names: ReadonlyArray<string>) =>
				names.length === 0 ? undefined : Arr.join(names, ", ")
			return {
				title: `Status page config applied: ${output.page.name}`,
				notices: unchanged
					? ["Nothing changed: the document matched the page."]
					: output.page.draft
						? [
								"The page is a draft, so the change stays private until publish_status_page publishes it.",
							]
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
	server.define({
		name: "create_status_page",
		title: "Create Status Page",
		description:
			"Create a status page as a draft: private until publish_status_page. It starts with no components; read its config with get_status_page include_config=true, add components (linked to uptime monitors), theme and links, and write them with apply_status_page_config. Only org admins and engineers may call it.",
		parameters: Schema.Struct({
			name: P.text("The page's public name, e.g. `Acme Status`"),
			slug: P.optionalText(
				"The page's address on Maple's status domain: 3 to 48 lowercase letters, digits or inner hyphens. Defaults to one made from `name` (`Acme Status` gives `acme-status`)",
			),
			description: P.optionalText("Optional public text under the page's title"),
		}),
		hints: MUTATION_HINTS,
		scopeFamily: "status_pages",
		phrases: ["Creating a status page"],
		handler: Effect.fn("McpTool.createStatusPage")(function* (params) {
			const tool = "create_status_page"
			const tenant = yield* CurrentMcpTenant
			yield* requireEditor(tenant.roles, tool, "creates a status page")
			const name = Str.trim(params.name)
			const slug = params.slug === undefined ? slugFromName(name) : Str.trim(params.slug)
			if (!isSlug(slug)) {
				return yield* new McpInvalidInputError({
					message:
						params.slug === undefined
							? `The name gives the address "${slug}", which is not a valid slug. Pass \`slug\`: 3 to 48 lowercase letters, digits or inner hyphens.`
							: "`slug` must be 3 to 48 lowercase letters, digits or inner hyphens, e.g. `acme-status`.",
					parameter: "slug",
				})
			}
			const created = yield* (yield* StatusPagesService)
				.create(tenant.orgId, {
					name,
					slug,
					...(params.description === undefined ? undefined : { description: params.description }),
					draft: true,
					createdBy: tenant.userId,
				})
				.pipe(
					Effect.mapError((error) =>
						error._tag === "@maple/http/errors/StatusPageSlugTakenError"
							? new McpInvalidInputError({
									message: `Another status page already has the address "${error.slug}". Pass a different \`slug\`.`,
									parameter: "slug",
								})
							: toMcpError(tool)(error),
					),
				)
			yield* auditPage("status_page.created", created.id, { name: created.name, slug: created.slug })
			return { page: toPageRow(created) }
		}),
		render: (output: typeof CreateStatusPageOutput.Type) => ({
			title: `Status page created: ${output.page.name}`,
			notices: [
				"It is a draft: nobody outside Maple sees it until publish_status_page. Next, read its config document, add components (each can follow an uptime monitor) and settings, and write the edited document with apply_status_page_config.",
			],
			blocks: [
				doc.fields([
					["Slug", output.page.slug],
					["Id", output.page.id],
					["Published", "draft, not public"],
				]),
			],
			next: [
				doc.next(
					"get_status_page",
					{ page: output.page.slug, include_config: true },
					"the config document to edit",
				),
			],
		}),
	})

	server.define({
		name: "publish_status_page",
		title: "Publish Status Page",
		description:
			"Make a draft status page public: it goes live at its address with the next publish, within a minute, and its published incidents become visible. Calling it on a page that is already public changes nothing. A password page still asks visitors for its password; an internal page is still shown only inside Maple. Only org admins and engineers may call it.",
		parameters: Schema.Struct({
			page: P.text("The page's slug, name or id"),
		}),
		hints: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
		scopeFamily: "status_pages",
		phrases: ["Publishing a status page"],
		handler: Effect.fn("McpTool.publishStatusPage")(function* (params) {
			const tool = "publish_status_page"
			const tenant = yield* CurrentMcpTenant
			yield* requireEditor(tenant.roles, tool, "publishes a status page")
			const page = yield* resolvePage(tool, tenant.orgId, params.page)
			if (!page.draft) return { action: "already_public" as const, page: toPageRow(page) }
			// The minutely publish writes it: this Worker has no edge storage to publish to itself.
			const published = yield* (yield* StatusPagesService)
				.makePublic(tenant.orgId, page.id)
				.pipe(Effect.mapError(toMcpError(tool)))
			yield* auditPage("status_page.published", published.id, {
				outcome: "queued",
				revision: published.revision,
			})
			return { action: "published" as const, page: toPageRow(published) }
		}),
		render: (output: typeof PublishStatusPageOutput.Type) => ({
			title:
				output.action === "published"
					? `Status page published: ${output.page.name}`
					: `Status page already public: ${output.page.name}`,
			notices: [
				output.action === "published"
					? "The page is public now and goes live with the next publish, within a minute."
					: "The page was already public, so nothing changed.",
				...(output.page.visibility === "password"
					? ["Visitors need the page's password to read it."]
					: output.page.visibility === "internal"
						? ["The page is internal: it is shown only inside Maple, on no public address."]
						: []),
			],
			blocks: [
				doc.fields([
					["Slug", output.page.slug],
					["Id", output.page.id],
					["Last published", output.page.publishedAt ?? "not yet"],
					["Publish error", output.page.lastPublishError ?? undefined],
				]),
			],
			next: [doc.next("get_status_page", { page: output.page.slug }, "the page as visitors see it")],
		}),
	})

	server.define({
		name: "set_status_page_domain",
		title: "Set Status Page Domain",
		description:
			"Serve a status page on the org's own subdomain (`status.acme.com`), or remove it with remove=true. Returns the DNS records to add at the domain's DNS provider: a CNAME to Maple and a TXT record proving ownership. Maple checks them on its own (every minute for the first hour, then every 10 minutes) and issues the certificate; a domain not live within 7 days is dropped. Calling it again with the page's current domain checks the records now and reports where the setup stands. One domain per page, none on an internal page. Only org admins and engineers may call it.",
		parameters: Schema.Struct({
			page: P.text("The page's slug, name or id"),
			domain: P.optionalText(
				"The hostname to serve the page on, a subdomain such as `status.acme.com` (an apex domain cannot take a CNAME). It replaces the page's current domain; the same domain checks it again",
			),
			remove: P.optionalFlag(
				"true removes the page's custom domain; the page stays on its Maple address. Takes no `domain`",
			),
		}),
		hints: { readOnly: false, destructive: true, idempotent: true, openWorld: true },
		scopeFamily: "status_pages",
		phrases: ["Setting a status page domain"],
		handler: Effect.fn("McpTool.setStatusPageDomain")(function* (params) {
			const tool = "set_status_page_domain"
			const tenant = yield* CurrentMcpTenant
			yield* requireEditor(tenant.roles, tool, "changes a status page's custom domain")
			const remove = params.remove === true
			if (remove && params.domain !== undefined) {
				return yield* new McpInvalidInputError({
					message: "Pass `domain` to set or check a domain, or remove=true to remove it, not both.",
					parameter: "remove",
				})
			}
			const requested = params.domain
			if (!remove && requested === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"Pass `domain` (e.g. `status.acme.com`) to set or check the page's custom domain, or remove=true to remove it.",
					parameter: "domain",
				})
			}
			const page = yield* resolvePage(tool, tenant.orgId, params.page)
			const customDomains = yield* StatusPageCustomDomainsService
			// A domain going live or away bumps the page's revision: report the page as it is after.
			const pages = yield* StatusPagesService
			const reread = () => pages.get(tenant.orgId, page.id).pipe(Effect.mapError(toMcpError(tool)))
			const before = yield* customDomains
				.get(tenant.orgId, page.id)
				.pipe(Effect.mapError(toMcpError(tool)))
			const previous = before.domain?.hostname ?? null
			if (requested === undefined) {
				if (previous === null)
					return { action: "unchanged" as const, page: toPageRow(page), domain: null }
				yield* customDomains.remove(tenant.orgId, page.id).pipe(Effect.mapError(toMcpError(tool)))
				yield* auditPage("status_page.custom_domain_removed", page.id, { hostname: previous })
				const after = yield* reread()
				return { action: "removed" as const, page: toPageRow(after), domain: null }
			}
			const hostname = normalizeCustomDomain(requested)
			// The same domain again is a check, as the dashboard's Check now: `set` would only re-read it.
			const same = previous === hostname
			const written: Effect.Effect<StatusPageCustomDomainView, StatusPageCustomDomainError> = same
				? customDomains.check(tenant.orgId, page.id)
				: customDomains.set(tenant.orgId, page.id, requested)
			const view = yield* written.pipe(
				Effect.mapError((error) =>
					// The hostname's issue, or an internal page, both fixed through `domain`.
					error._tag === "@maple/http/errors/StatusPageValidationError"
						? new McpInvalidInputError({ message: error.message, parameter: "domain" })
						: toMcpError(tool)(error),
				),
			)
			if (!same) {
				yield* auditPage("status_page.custom_domain_set", page.id, {
					hostname,
					previous_hostname: previous,
				})
			}
			const after = yield* reread()
			return {
				action: same ? ("checked" as const) : ("set" as const),
				page: toPageRow(after),
				domain: view.domain === null ? null : toDomainRow(view.domain),
			}
		}),
		render: (output: typeof SetStatusPageDomainOutput.Type) => {
			const { domain, page } = output
			if (domain === null) {
				return {
					title:
						output.action === "removed"
							? `Custom domain removed: ${page.name}`
							: `No custom domain: ${page.name}`,
					notices: [
						output.action === "removed"
							? "The page is served on its Maple address only. Its DNS records can be deleted."
							: "The page had no custom domain, so nothing changed.",
					],
					blocks: [],
					next: [doc.next("get_status_page", { page: page.slug }, "the page as visitors see it")],
				}
			}
			const live = domain.status === "active"
			return {
				title: `Custom domain ${domain.hostname}: ${page.name}`,
				notices: [
					live
						? `Live: the page answers at https://${domain.hostname}.`
						: domain.status === "pending_dns"
							? `Add these records at the DNS provider for ${domain.hostname}. Maple checks them every minute for the first hour, then every 10 minutes; call set_status_page_domain with the same domain to check now. A domain not live within 7 days is removed.`
							: domain.status === "pending_ssl"
								? "The DNS records are in place; the certificate is being issued, usually within minutes."
								: `The setup stopped${domain.lastError === null ? "" : `: ${domain.lastError}`}. Fix the records, then call set_status_page_domain with the same domain to try again.`,
					...(page.draft
						? ["The page is a draft: the domain serves it once publish_status_page publishes it."]
						: []),
				],
				blocks: [
					doc.fields([
						["Status", domain.status],
						["Last error", live ? undefined : (domain.lastError ?? undefined)],
						["Last checked", domain.lastCheckedAt ?? undefined],
						["Live since", domain.activatedAt ?? undefined],
					]),
					doc.table(
						["Type", "Name", "Value", "For"],
						Arr.map(domain.dnsRecords, (record) => [
							record.type,
							record.name,
							record.value,
							record.purpose,
						]),
					),
				],
				next: live
					? [doc.next("get_status_page", { page: page.slug }, "the page as visitors see it")]
					: [
							doc.next(
								"set_status_page_domain",
								{ page: page.slug, domain: domain.hostname },
								"check the records again once they are added",
							),
						],
			}
		},
	})
}
