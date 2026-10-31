import { randomBytes, randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	StatusPageComponents,
	StatusPageIncidentComponents,
	StatusPageIncidentUpdates,
	StatusPageIncidents,
	StatusPages,
	UptimeMonitors,
	type StatusPageComponentRow,
	type StatusPageIncidentRow,
	type StatusPageIncidentUpdateRow,
	type StatusPageRow,
} from "@maple/db/tables"
import {
	StatusPageComponentNotFoundError,
	StatusPageConflictError,
	StatusPageIncidentNotFoundError,
	StatusPageNotFoundError,
	StatusPagePersistenceError,
	StatusPageSlugTakenError,
	StatusPageValidationError,
	type StatusPageComponentRecord,
	type StatusPageIncidentRecord,
	type StatusPageIncidentUpdateRecord,
	type StatusPageRecord,
} from "@maple/domain/http"
import {
	diffStatusPageConfig,
	hasStatusPageConfigChanges,
	MAX_STATUS_PAGE_COMPONENTS,
	normalizeStatusPageConfig,
	StatusPageComponentPublicId,
	statusPageConfigVersion,
	type StatusPageConfig,
	type StatusPageConfigChangeSet,
	type StatusPageDraftComponent,
} from "@maple/domain/http/v2"
import {
	StatusPageComponentId,
	StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentUpdateId,
	type OrgId,
	type StatusPageAutoIncidents,
	type StatusPageComponentStatus,
	type StatusPageIncidentImpact,
	type StatusPageIncidentKind,
	type StatusPageIncidentStatus,
	type StatusPageUpdateSource,
	type UptimeMonitorId,
	type UserId,
} from "@maple/domain/primitives"
import {
	DEFAULT_STATUS_PAGE_THEME,
	STATUS_PAGE_BREAK_GLASS_PREFIX,
	STATUS_PAGE_HEX_COLOR_PATTERN,
	StatusPageSlug,
	type StatusPageTheme,
	sha256Base64Url,
	themeContrastIssue,
	STATUS_PAGE_MAX_URL_LENGTH,
} from "@maple/domain/status-page"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { postgresSqlState } from "@maple/backend/platform/postgres-errors"
import { ensureMonitorsInOrg } from "./monitors"
import { bumpPage, queuePageRemoval, queueSlugRemoval } from "./outbox"

export interface CreateStatusPageInput {
	readonly name: string
	readonly slug: string
	readonly description?: string | null
	readonly websiteUrl?: string | null
	readonly logoUrl?: string | null
	readonly privacyUrl?: string | null
	readonly termsUrl?: string | null
	readonly theme?: StatusPageTheme
	readonly showPoweredBy?: boolean
	readonly autoIncidents?: StatusPageAutoIncidents
	/** Written with the page in its transaction; list order is display order. */
	readonly components?: ReadonlyArray<StatusPageDraftComponent>
	/** A draft is not published until `makePublic`. */
	readonly draft?: boolean
	readonly createdBy: UserId
}

export interface UpdateStatusPageInput {
	readonly name?: string
	readonly slug?: string
	readonly description?: string | null
	readonly websiteUrl?: string | null
	readonly logoUrl?: string | null
	readonly privacyUrl?: string | null
	readonly termsUrl?: string | null
	/** Merged onto the stored theme under the page's row lock, so concurrent partial edits both land. */
	readonly theme?: Partial<StatusPageTheme>
	readonly showPoweredBy?: boolean
	readonly autoIncidents?: StatusPageAutoIncidents
}

export interface CreateStatusPageComponentInput {
	readonly name: string
	readonly description?: string | null
	readonly groupName?: string | null
	readonly monitorId?: UptimeMonitorId | null
	readonly manualStatus?: StatusPageComponentStatus | null
	readonly showUptime?: boolean
}

export type UpdateStatusPageComponentInput = Partial<CreateStatusPageComponentInput>

export interface ListStatusPageIncidentsOptions {
	/** Resolved incidents and completed maintenance too; open ones only by default. */
	readonly includeResolved?: boolean
}

/** One page of an org's incidents, filtered and ordered in SQL (newest first). */
export interface ListOrgStatusPageIncidentsOptions {
	/** One page, or null for every page of the org. */
	readonly pageId: StatusPageId | null
	readonly state: "open" | "closed" | "all"
	readonly limit: number
	readonly offset: number
}

export interface CreateStatusPageIncidentInput {
	readonly kind: StatusPageIncidentKind
	readonly title: string
	readonly impact: StatusPageIncidentImpact
	readonly status: StatusPageIncidentStatus
	readonly body: string
	readonly componentIds: ReadonlyArray<StatusPageComponentId>
	readonly published?: boolean
	readonly scheduledStart?: number | null
	readonly scheduledEnd?: number | null
	readonly source: StatusPageUpdateSource
	readonly createdBy?: UserId | null
}

export interface PostStatusPageIncidentUpdateInput {
	readonly status: StatusPageIncidentStatus
	readonly body: string
	readonly impact?: StatusPageIncidentImpact
	readonly componentIds?: ReadonlyArray<StatusPageComponentId>
	readonly source: StatusPageUpdateSource
	readonly createdBy?: UserId | null
	/** Publishes a draft in the same write, so the update and its visibility never split. */
	readonly publish?: boolean
}

export interface UpdateStatusPageIncidentInput {
	readonly title?: string
	readonly impact?: StatusPageIncidentImpact
	readonly published?: boolean
	readonly scheduledStart?: number | null
	readonly scheduledEnd?: number | null
	readonly componentIds?: ReadonlyArray<StatusPageComponentId>
}

type PageError = StatusPageNotFoundError | StatusPagePersistenceError
type PageWriteError = PageError | StatusPageValidationError
type ComponentError = PageWriteError | StatusPageComponentNotFoundError
type IncidentError = PageWriteError | StatusPageIncidentNotFoundError

export interface StatusPagesServiceApi {
	readonly list: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<StatusPageRecord>, StatusPagePersistenceError>
	readonly get: (orgId: OrgId, pageId: StatusPageId) => Effect.Effect<StatusPageRecord, PageError>
	readonly create: (
		orgId: OrgId,
		input: CreateStatusPageInput,
	) => Effect.Effect<
		StatusPageRecord,
		StatusPageValidationError | StatusPageSlugTakenError | StatusPagePersistenceError
	>
	readonly update: (
		orgId: OrgId,
		pageId: StatusPageId,
		patch: UpdateStatusPageInput,
	) => Effect.Effect<StatusPageRecord, PageWriteError | StatusPageSlugTakenError>
	readonly remove: (orgId: OrgId, pageId: StatusPageId) => Effect.Effect<StatusPageId, PageError>
	/** Clears `draft` so the publisher takes the page; a page already public is unchanged. */
	readonly makePublic: (orgId: OrgId, pageId: StatusPageId) => Effect.Effect<StatusPageRecord, PageError>
	/** Returns the new raw token; only its hash and last 6 characters are stored. */
	readonly rotateBreakGlassToken: (orgId: OrgId, pageId: StatusPageId) => Effect.Effect<string, PageError>
	readonly revokeBreakGlassToken: (orgId: OrgId, pageId: StatusPageId) => Effect.Effect<void, PageError>
	readonly listComponents: (
		orgId: OrgId,
		pageId: StatusPageId,
	) => Effect.Effect<ReadonlyArray<StatusPageComponentRecord>, PageError>
	readonly createComponent: (
		orgId: OrgId,
		pageId: StatusPageId,
		input: CreateStatusPageComponentInput,
	) => Effect.Effect<StatusPageComponentRecord, PageWriteError>
	readonly updateComponent: (
		orgId: OrgId,
		componentId: StatusPageComponentId,
		patch: UpdateStatusPageComponentInput,
	) => Effect.Effect<StatusPageComponentRecord, ComponentError>
	readonly removeComponent: (
		orgId: OrgId,
		componentId: StatusPageComponentId,
	) => Effect.Effect<StatusPageComponentId, ComponentError>
	/** `componentIds` must list every component of the page once; position = index. */
	readonly reorderComponents: (
		orgId: OrgId,
		pageId: StatusPageId,
		componentIds: ReadonlyArray<StatusPageComponentId>,
	) => Effect.Effect<ReadonlyArray<StatusPageComponentRecord>, PageWriteError>
	readonly listIncidents: (
		orgId: OrgId,
		pageId: StatusPageId,
		options?: ListStatusPageIncidentsOptions,
	) => Effect.Effect<ReadonlyArray<StatusPageIncidentRecord>, PageError>
	readonly listOrgIncidents: (
		orgId: OrgId,
		options: ListOrgStatusPageIncidentsOptions,
	) => Effect.Effect<ReadonlyArray<StatusPageIncidentRecord>, PageError>
	readonly getIncident: (
		orgId: OrgId,
		incidentId: StatusPageIncidentId,
	) => Effect.Effect<StatusPageIncidentRecord, StatusPageIncidentNotFoundError | StatusPagePersistenceError>
	readonly createIncident: (
		orgId: OrgId,
		pageId: StatusPageId,
		input: CreateStatusPageIncidentInput,
	) => Effect.Effect<StatusPageIncidentRecord, PageWriteError>
	readonly postUpdate: (
		orgId: OrgId,
		incidentId: StatusPageIncidentId,
		input: PostStatusPageIncidentUpdateInput,
	) => Effect.Effect<StatusPageIncidentRecord, IncidentError>
	readonly updateIncident: (
		orgId: OrgId,
		incidentId: StatusPageIncidentId,
		patch: UpdateStatusPageIncidentInput,
	) => Effect.Effect<StatusPageIncidentRecord, IncidentError>
	readonly removeIncident: (
		orgId: OrgId,
		incidentId: StatusPageIncidentId,
	) => Effect.Effect<StatusPageIncidentId, IncidentError>
	/** The page's settings, theme and components as one document. */
	readonly getConfig: (orgId: OrgId, pageId: StatusPageId) => Effect.Effect<StatusPageConfig, PageError>
	/**
	 * Replaces the page with `config` in one transaction: all of it applies, or none of it. With
	 * `ifVersion`, a config edited since that version fails with a conflict and nothing is written.
	 */
	readonly applyConfig: (
		orgId: OrgId,
		pageId: StatusPageId,
		config: StatusPageConfig,
		actor: UserId,
		options?: { readonly ifVersion?: string | undefined },
	) => Effect.Effect<
		AppliedStatusPageConfig,
		PageWriteError | StatusPageSlugTakenError | StatusPageConflictError
	>
}

/** The page before and after the write, and what changed, all read under the page lock. */
export interface AppliedStatusPageConfig {
	readonly previous: StatusPageConfig
	readonly config: StatusPageConfig
	readonly changes: StatusPageConfigChangeSet
}

const MAX_NAME_LENGTH = 120
const MAX_TEXT_LENGTH = 2000
const INCIDENT_STATUSES: ReadonlySet<StatusPageIncidentStatus> = new Set([
	"investigating",
	"identified",
	"monitoring",
	"resolved",
])
const MAINTENANCE_STATUSES: ReadonlySet<StatusPageIncidentStatus> = new Set([
	"scheduled",
	"in_progress",
	"completed",
])
const isClosedStatus = (status: StatusPageIncidentStatus) => status === "resolved" || status === "completed"

const toPersistenceError = (error: unknown) =>
	new StatusPagePersistenceError({
		message: error instanceof Error ? error.message : "Status page persistence failed",
		cause: error,
	})

const invalid = (message: string) => new StatusPageValidationError({ message })
const pageNotFound = (pageId: StatusPageId) =>
	new StatusPageNotFoundError({ pageId, message: "Status page not found" })
const componentNotFound = (componentId: StatusPageComponentId) =>
	new StatusPageComponentNotFoundError({ componentId, message: "Status page component not found" })
const incidentNotFound = (incidentId: StatusPageIncidentId) =>
	new StatusPageIncidentNotFoundError({ incidentId, message: "Status page incident not found" })
const slugTaken = (slug: string) =>
	new StatusPageSlugTakenError({ slug, message: `The address '${slug}' is already taken` })

const isValidSlug = Schema.is(StatusPageSlug)

const validateName = (raw: string, what: string) => {
	const name = raw.trim()
	if (name.length === 0) return Effect.fail(invalid(`${what} is required`))
	if (name.length > MAX_NAME_LENGTH)
		return Effect.fail(invalid(`${what} must be at most ${MAX_NAME_LENGTH} characters`))
	return Effect.succeed(name)
}

/** Optional free text: blank becomes null. */
const validateText = (raw: string | null, what: string) => {
	const text = raw?.trim() ?? ""
	if (text.length > MAX_TEXT_LENGTH)
		return Effect.fail(invalid(`${what} must be at most ${MAX_TEXT_LENGTH} characters`))
	return Effect.succeed(text.length === 0 ? null : text)
}

const validateSlug = (slug: string) =>
	isValidSlug(slug)
		? Effect.succeed(slug)
		: Effect.fail(
				invalid("Slug must be 3-48 lowercase letters, digits or inner hyphens (e.g. 'acme-status')"),
			)

const validateHttpsUrl = (raw: string | null, what: string) => {
	const value = raw?.trim() ?? ""
	if (value.length === 0) return Effect.succeed(null)
	if (value.length > STATUS_PAGE_MAX_URL_LENGTH || !URL.canParse(value))
		return Effect.fail(invalid(`${what} must be a valid URL`))
	if (new URL(value).protocol !== "https:") return Effect.fail(invalid(`${what} must use https`))
	return Effect.succeed(value)
}

/** Blank is no colour; anything else must be `#rrggbb`, stored lower-cased. */
const validateHex = (raw: string | null, what: string) => {
	const value = raw?.trim() ?? ""
	if (value.length === 0) return Effect.succeed(null)
	return STATUS_PAGE_HEX_COLOR_PATTERN.test(value)
		? Effect.succeed(value.toLowerCase())
		: Effect.fail(invalid(`${what} must be a hex color like #1a2b3c`))
}

/** Hex colours normalized, and refused when the text would be hard to read. */
const validateTheme = Effect.fnUntraced(function* (theme: StatusPageTheme) {
	const normalized: StatusPageTheme = {
		...theme,
		accent: yield* validateHex(theme.accent, "Accent color"),
		background: yield* validateHex(theme.background, "Background color"),
		text: yield* validateHex(theme.text, "Text color"),
		card: yield* validateHex(theme.card, "Card color"),
		border: yield* validateHex(theme.border, "Border color"),
	}
	const issue = themeContrastIssue(normalized)
	if (issue !== null) return yield* Effect.fail(invalid(issue))
	return normalized
})

const validateStatusForKind = (kind: StatusPageIncidentKind, status: StatusPageIncidentStatus) => {
	const allowed = kind === "maintenance" ? MAINTENANCE_STATUSES : INCIDENT_STATUSES
	return allowed.has(status)
		? Effect.void
		: Effect.fail(
				invalid(
					`Status '${status}' does not apply to ${kind === "maintenance" ? "maintenance" : "an incident"}`,
				),
			)
}

const validateWindow = (
	kind: StatusPageIncidentKind,
	scheduledStart: number | null,
	scheduledEnd: number | null,
) => {
	if (kind === "incident") {
		return scheduledStart === null && scheduledEnd === null
			? Effect.void
			: Effect.fail(invalid("Only maintenance has a scheduled window"))
	}
	if (scheduledStart === null || scheduledEnd === null)
		return Effect.fail(invalid("Maintenance needs a scheduled start and end"))
	return scheduledEnd > scheduledStart
		? Effect.void
		: Effect.fail(invalid("Maintenance must end after it starts"))
}

const validateUpdateBody = (raw: string) => {
	const body = raw.trim()
	if (body.length === 0) return Effect.fail(invalid("An update needs a message"))
	if (body.length > MAX_TEXT_LENGTH)
		return Effect.fail(invalid(`An update must be at most ${MAX_TEXT_LENGTH} characters`))
	return Effect.succeed(body)
}

const toPageRecord = (row: StatusPageRow): StatusPageRecord => ({
	id: row.id,
	orgId: row.orgId,
	name: row.name,
	slug: row.slug,
	description: row.description,
	websiteUrl: row.websiteUrl,
	logoUrl: row.logoUrl,
	privacyUrl: row.privacyUrl,
	termsUrl: row.termsUrl,
	theme: row.theme,
	showPoweredBy: row.showPoweredBy,
	autoIncidents: row.autoIncidents,
	breakGlassTokenSuffix: row.breakGlassTokenSuffix,
	draft: row.draft,
	revision: row.revision,
	publishedRevision: row.publishedRevision,
	publishedAt: row.publishedAt,
	lastPublishError: row.lastPublishError,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

const toComponentRecord = (row: StatusPageComponentRow): StatusPageComponentRecord => ({
	id: row.id,
	pageId: row.pageId,
	name: row.name,
	description: row.description,
	groupName: row.groupName,
	position: row.position,
	monitorId: row.monitorId,
	manualStatus: row.manualStatus,
	showUptime: row.showUptime,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

const toUpdateRecord = (row: StatusPageIncidentUpdateRow): StatusPageIncidentUpdateRecord => ({
	id: row.id,
	status: row.status,
	body: row.body,
	source: row.source,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
})

/** Incidents with their component links and updates (newest first), in two org-scoped reads. */
const loadIncidents = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	rows: ReadonlyArray<StatusPageIncidentRow>,
) {
	const [first, ...rest] = rows.map((row) => row.id)
	if (first === undefined) return []
	const links = yield* db.run(
		PG.from(StatusPageIncidentComponents)
			.select()
			.where(($) => [$.orgId.eq(orgId), $.incidentId.in_(first, ...rest)]),
	)
	const updates = yield* db.run(
		PG.from(StatusPageIncidentUpdates)
			.select()
			.where(($) => [$.orgId.eq(orgId), $.incidentId.in_(first, ...rest)])
			.orderBy(["createdAt", "desc"], ["id", "desc"]),
	)
	return rows.map((row): StatusPageIncidentRecord => ({
		id: row.id,
		pageId: row.pageId,
		kind: row.kind,
		title: row.title,
		impact: row.impact,
		status: row.status,
		published: row.published,
		scheduledStart: row.scheduledStart,
		scheduledEnd: row.scheduledEnd,
		startedAt: row.startedAt,
		resolvedAt: row.resolvedAt,
		componentIds: links.filter((link) => link.incidentId === row.id).map((link) => link.componentId),
		updates: updates.filter((update) => update.incidentId === row.id).map(toUpdateRecord),
		createdBy: row.createdBy,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}))
})

/** `lock` holds the row until commit, for a read-modify-write such as a partial theme merge. */
const findPage = (
	db: MapleDb,
	orgId: OrgId,
	pageId: StatusPageId,
	options: { readonly lock: boolean } = { lock: false },
) => {
	const query = PG.from(StatusPages)
		.select()
		.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)])
		.limit(1)
	return db
		.run(options.lock ? query.forUpdate() : query)
		.pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined ? Effect.fail(pageNotFound(pageId)) : Effect.succeed(rows[0]),
			),
		)
}

/**
 * The page row, locked until the transaction ends. Every component write takes it first, so an
 * apply and component edits on one page run one at a time.
 */
const lockPage = (db: MapleDb, orgId: OrgId, pageId: StatusPageId) =>
	db
		.run(
			PG.from(StatusPages)
				.select()
				.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)])
				.limit(1)
				.forUpdate(),
		)
		.pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined ? Effect.fail(pageNotFound(pageId)) : Effect.succeed(rows[0]),
			),
		)

const tooManyComponents = () =>
	invalid(`A status page can have at most ${MAX_STATUS_PAGE_COMPONENTS} components`)

const findComponent = (db: MapleDb, orgId: OrgId, componentId: StatusPageComponentId) =>
	db
		.run(
			PG.from(StatusPageComponents)
				.select()
				.where(($) => [$.orgId.eq(orgId), $.id.eq(componentId)])
				.limit(1),
		)
		.pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined ? Effect.fail(componentNotFound(componentId)) : Effect.succeed(rows[0]),
			),
		)

const findIncident = (db: MapleDb, orgId: OrgId, incidentId: StatusPageIncidentId) =>
	db
		.run(
			PG.from(StatusPageIncidents)
				.select()
				.where(($) => [$.orgId.eq(orgId), $.id.eq(incidentId)])
				.limit(1),
		)
		.pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined ? Effect.fail(incidentNotFound(incidentId)) : Effect.succeed(rows[0]),
			),
		)

/** The slug check is deliberately global: one hosted address per slug across all orgs. */
const ensureSlugFree = Effect.fnUntraced(function* (
	db: MapleDb,
	slug: string,
	exceptPageId: StatusPageId | null,
) {
	const rows = yield* db.run(
		PG.from(StatusPages)
			.select("id")
			.where(($) => [$.slug.eq(slug), exceptPageId === null ? undefined : $.id.neq(exceptPageId)])
			.limit(1)
			.crossTenant(),
	)
	if (rows.length > 0) return yield* slugTaken(slug)
})

const ensureMonitorInOrg = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	monitorId: UptimeMonitorId,
) {
	const rows = yield* db.run(
		PG.from(UptimeMonitors)
			.select("id")
			.where(($) => [$.orgId.eq(orgId), $.id.eq(monitorId)])
			.limit(1),
	)
	if (rows.length === 0) return yield* invalid(`Unknown uptime monitor ${monitorId}`)
})

/** Every id must name a component of this page. */
const ensureComponentsOnPage = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	pageId: StatusPageId,
	componentIds: ReadonlyArray<StatusPageComponentId>,
) {
	const [first, ...rest] = componentIds
	if (first === undefined) return
	const found = yield* db.run(
		PG.from(StatusPageComponents)
			.select("id")
			.where(($) => [$.orgId.eq(orgId), $.pageId.eq(pageId), $.id.in_(first, ...rest)]),
	)
	const known = new Set(found.map((row) => row.id))
	const missing = componentIds.find((id) => !known.has(id))
	if (missing !== undefined) return yield* invalid(`Component ${missing} is not on this page`)
})

const replaceIncidentComponents = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	incidentId: StatusPageIncidentId,
	componentIds: ReadonlyArray<StatusPageComponentId>,
) {
	yield* db.run(
		PG.deleteFrom(StatusPageIncidentComponents).where(($) => [
			$.orgId.eq(orgId),
			$.incidentId.eq(incidentId),
		]),
	)
	if (componentIds.length === 0) return
	yield* db.run(
		PG.insertInto(StatusPageIncidentComponents).values(
			componentIds.map((componentId) => ({ incidentId, componentId, orgId })),
		),
	)
})

const encodeComponentId = Schema.encodeSync(StatusPageComponentPublicId)

const contentOf = (
	page: StatusPageRow,
	components: ReadonlyArray<StatusPageComponentRow>,
): StatusPageConfig => ({
	name: page.name,
	slug: page.slug,
	description: page.description,
	website_url: page.websiteUrl,
	logo_url: page.logoUrl,
	privacy_url: page.privacyUrl,
	terms_url: page.termsUrl,
	show_powered_by: page.showPoweredBy,
	auto_incidents: page.autoIncidents,
	theme: page.theme,
	components: components.map((component) => ({
		id: component.id,
		name: component.name,
		description: component.description,
		group: component.groupName,
		monitor_id: component.monitorId,
		manual_status: component.manualStatus,
		show_uptime: component.showUptime,
	})),
})

/** The page's config as a read returns it, tagged with its content version. */
const toConfig = (
	page: StatusPageRow,
	components: ReadonlyArray<StatusPageComponentRow>,
): StatusPageConfig => {
	const content = contentOf(page, components)
	return { version: statusPageConfigVersion(content), ...content }
}

/** One config component, validated and with its defaults, before any id is checked. */
const validateConfigComponent = Effect.fnUntraced(function* (
	component: StatusPageConfig["components"][number],
	index: number,
) {
	const at = `components[${index}]`
	return {
		id: component.id ?? null,
		name: yield* validateName(component.name, `${at}.name`),
		description: yield* validateText(component.description ?? null, `${at}.description`),
		groupName: yield* validateText(component.group ?? null, `${at}.group`),
		monitorId: component.monitor_id ?? null,
		manualStatus: component.manual_status ?? null,
		showUptime: component.show_uptime ?? true,
	}
})

const newBreakGlassToken = () => `${STATUS_PAGE_BREAK_GLASS_PREFIX}${randomBytes(32).toString("base64url")}`

/** Newest incidents a list returns: with history included, a long-lived page stays bounded. */
const INCIDENT_LIST_LIMIT = 200

export class StatusPagesService extends Context.Service<StatusPagesService, StatusPagesServiceApi>()(
	"@maple/backend/services/status-pages/StatusPagesService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "StatusPagesService", toPersistenceError)
			// A slug race that slips past the in-transaction check lands on the unique index.
			const dbExecuteSlug = (slug: string) =>
				makeDbExecute(database, "StatusPagesService", (error: DatabaseError) =>
					postgresSqlState(error) === "23505" ? slugTaken(slug) : toPersistenceError(error),
				)

			const requirePage = (orgId: OrgId, pageId: StatusPageId) =>
				dbExecute((db) => findPage(db, orgId, pageId)).pipe(Effect.map(toPageRecord))

			const requireIncident = (orgId: OrgId, incidentId: StatusPageIncidentId) =>
				dbExecute((db) =>
					findIncident(db, orgId, incidentId).pipe(
						Effect.flatMap((row) => loadIncidents(db, orgId, [row])),
					),
				).pipe(
					Effect.flatMap((records) =>
						records[0] === undefined
							? Effect.fail(incidentNotFound(incidentId))
							: Effect.succeed(records[0]),
					),
				)

			const list = Effect.fn("StatusPagesService.list")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(StatusPages)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["createdAt", "asc"], ["id", "asc"]),
					),
				)
				return rows.map(toPageRecord)
			})

			const get = Effect.fn("StatusPagesService.get")(function* (orgId: OrgId, pageId: StatusPageId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				return yield* requirePage(orgId, pageId)
			})

			const create = Effect.fn("StatusPagesService.create")(function* (
				orgId: OrgId,
				input: CreateStatusPageInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const name = yield* validateName(input.name, "Name")
				const slug = yield* validateSlug(input.slug)
				const description = yield* validateText(input.description ?? null, "Description")
				const websiteUrl = yield* validateHttpsUrl(input.websiteUrl ?? null, "Website URL")
				const logoUrl = yield* validateHttpsUrl(input.logoUrl ?? null, "Logo URL")
				const privacyUrl = yield* validateHttpsUrl(input.privacyUrl ?? null, "Privacy policy URL")
				const termsUrl = yield* validateHttpsUrl(input.termsUrl ?? null, "Terms of service URL")
				const theme = yield* validateTheme(input.theme ?? DEFAULT_STATUS_PAGE_THEME)
				const draftComponents = input.components ?? []
				if (draftComponents.length > MAX_STATUS_PAGE_COMPONENTS) return yield* tooManyComponents()
				const components = yield* Effect.forEach(draftComponents, validateConfigComponent)
				const monitorIds = [
					...new Set(components.flatMap((c) => (c.monitorId === null ? [] : [c.monitorId]))),
				]
				const now = yield* Clock.currentTimeMillis
				const id = StatusPageId.make(randomUUID())
				yield* dbExecuteSlug(slug)((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* ensureSlugFree(db, slug, null)
							yield* ensureMonitorsInOrg(db, orgId, monitorIds)
							// A new page starts at revision 1 > published 0, so the publisher picks it up.
							yield* db.run(
								PG.insertInto(StatusPages).values({
									id,
									orgId,
									name,
									slug,
									description,
									websiteUrl,
									logoUrl,
									privacyUrl,
									termsUrl,
									theme,
									showPoweredBy: input.showPoweredBy ?? true,
									autoIncidents: input.autoIncidents ?? "off",
									breakGlassTokenSha256: null,
									breakGlassTokenSuffix: null,
									draft: input.draft ?? false,
									publishedAt: null,
									lastPublishError: null,
									createdBy: input.createdBy,
									createdAt: now,
									updatedAt: now,
								}),
							)
							const rows = components.map((component, position) => ({
								id: StatusPageComponentId.make(randomUUID()),
								orgId,
								pageId: id,
								name: component.name,
								description: component.description,
								groupName: component.groupName,
								position,
								monitorId: component.monitorId,
								manualStatus: component.manualStatus,
								showUptime: component.showUptime,
								createdAt: now,
								updatedAt: now,
							}))
							if (rows.length > 0)
								yield* db.run(PG.insertInto(StatusPageComponents).values(rows))
						}),
					),
				)
				return yield* requirePage(orgId, id).pipe(
					Effect.catchTag("@maple/http/errors/StatusPageNotFoundError", () =>
						Effect.fail(
							new StatusPagePersistenceError({ message: "Created status page not found" }),
						),
					),
				)
			})

			const update = Effect.fn("StatusPagesService.update")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
				patch: UpdateStatusPageInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const name = patch.name === undefined ? undefined : yield* validateName(patch.name, "Name")
				const slug = patch.slug === undefined ? undefined : yield* validateSlug(patch.slug)
				const description =
					patch.description === undefined
						? undefined
						: yield* validateText(patch.description, "Description")
				const websiteUrl =
					patch.websiteUrl === undefined
						? undefined
						: yield* validateHttpsUrl(patch.websiteUrl, "Website URL")
				const logoUrl =
					patch.logoUrl === undefined
						? undefined
						: yield* validateHttpsUrl(patch.logoUrl, "Logo URL")
				const privacyUrl =
					patch.privacyUrl === undefined
						? undefined
						: yield* validateHttpsUrl(patch.privacyUrl, "Privacy policy URL")
				const termsUrl =
					patch.termsUrl === undefined
						? undefined
						: yield* validateHttpsUrl(patch.termsUrl, "Terms of service URL")
				const now = yield* Clock.currentTimeMillis
				yield* dbExecuteSlug(slug ?? "")((db) =>
					db.transaction(
						Effect.gen(function* () {
							const current = yield* findPage(db, orgId, pageId, {
								lock: patch.theme !== undefined,
							})
							const theme =
								patch.theme === undefined
									? undefined
									: yield* validateTheme({ ...current.theme, ...patch.theme })
							if (slug !== undefined) yield* ensureSlugFree(db, slug, pageId)
							// The old slug route stays at the edge until the publisher drains this.
							if (slug !== undefined && slug !== current.slug)
								yield* queueSlugRemoval(db, orgId, pageId, current.slug)
							yield* db.run(
								PG.update(StatusPages)
									.set({
										...(name === undefined ? undefined : { name }),
										...(slug === undefined ? undefined : { slug }),
										...(description === undefined ? undefined : { description }),
										...(websiteUrl === undefined ? undefined : { websiteUrl }),
										...(logoUrl === undefined ? undefined : { logoUrl }),
										...(privacyUrl === undefined ? undefined : { privacyUrl }),
										...(termsUrl === undefined ? undefined : { termsUrl }),
										...(theme === undefined ? undefined : { theme }),
										...(patch.showPoweredBy === undefined
											? undefined
											: { showPoweredBy: patch.showPoweredBy }),
										...(patch.autoIncidents === undefined
											? undefined
											: { autoIncidents: patch.autoIncidents }),
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)]),
							)
							yield* bumpPage(db, orgId, pageId)
						}),
					),
				)
				return yield* requirePage(orgId, pageId)
			})

			/** Components, incidents and updates go with it through the foreign-key cascade. */
			const remove = Effect.fn("StatusPagesService.remove")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const removed = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// Queued before the delete reads the row; the publisher removes the edge copy.
							yield* queuePageRemoval(db, orgId, pageId)
							return yield* db.run(
								PG.deleteFrom(StatusPages)
									.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)])
									.returning("id"),
							)
						}),
					),
				)
				if (removed.length === 0) return yield* pageNotFound(pageId)
				return pageId
			})

			const makePublic = Effect.fn("StatusPagesService.makePublic")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* findPage(db, orgId, pageId)
							const cleared = yield* db.run(
								PG.update(StatusPages)
									.set({ draft: false, updatedAt: now })
									.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId), $.draft.eq(true)])
									.returning("id"),
							)
							if (cleared.length > 0) yield* bumpPage(db, orgId, pageId)
						}),
					),
				)
				return yield* requirePage(orgId, pageId)
			})

			const rotateBreakGlassToken = Effect.fn("StatusPagesService.rotateBreakGlassToken")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const token = newBreakGlassToken()
				const hash = yield* Effect.promise(() => sha256Base64Url(token))
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* findPage(db, orgId, pageId)
							yield* db.run(
								PG.update(StatusPages)
									.set({
										breakGlassTokenSha256: hash,
										breakGlassTokenSuffix: token.slice(-6),
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)]),
							)
							// The edge checks the published hash, so a rotation must republish.
							yield* bumpPage(db, orgId, pageId)
						}),
					),
				)
				return token
			})

			const revokeBreakGlassToken = Effect.fn("StatusPagesService.revokeBreakGlassToken")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* findPage(db, orgId, pageId)
							yield* db.run(
								PG.update(StatusPages)
									.set({
										breakGlassTokenSha256: null,
										breakGlassTokenSuffix: null,
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)]),
							)
							yield* bumpPage(db, orgId, pageId)
						}),
					),
				)
			})

			const selectComponents = (db: MapleDb, orgId: OrgId, pageId: StatusPageId) =>
				db.run(
					PG.from(StatusPageComponents)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.pageId.eq(pageId)])
						.orderBy(["position", "asc"], ["createdAt", "asc"], ["id", "asc"]),
				)

			const listComponents = Effect.fn("StatusPagesService.listComponents")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const rows = yield* dbExecute((db) =>
					findPage(db, orgId, pageId).pipe(Effect.andThen(selectComponents(db, orgId, pageId))),
				)
				return rows.map(toComponentRecord)
			})

			const createComponent = Effect.fn("StatusPagesService.createComponent")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
				input: CreateStatusPageComponentInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const name = yield* validateName(input.name, "Name")
				const description = yield* validateText(input.description ?? null, "Description")
				const groupName = yield* validateText(input.groupName ?? null, "Group name")
				const monitorId = input.monitorId ?? null
				const now = yield* Clock.currentTimeMillis
				const id = StatusPageComponentId.make(randomUUID())
				const row = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockPage(db, orgId, pageId)
							if (monitorId !== null) yield* ensureMonitorInOrg(db, orgId, monitorId)
							const existing = yield* selectComponents(db, orgId, pageId)
							if (existing.length >= MAX_STATUS_PAGE_COMPONENTS)
								return yield* tooManyComponents()
							const inserted = yield* db.run(
								PG.insertInto(StatusPageComponents)
									.values({
										id,
										orgId,
										pageId,
										name,
										description,
										groupName,
										// After the highest, not at the count: deletes leave gaps, so the count can be taken.
										position: existing.reduce(
											(top, row) => Math.max(top, row.position + 1),
											0,
										),
										monitorId,
										manualStatus: input.manualStatus ?? null,
										showUptime: input.showUptime ?? true,
										createdAt: now,
										updatedAt: now,
									})
									.returning(),
							)
							yield* bumpPage(db, orgId, pageId)
							return inserted
						}),
					),
				)
				const created = row[0]
				if (created === undefined)
					return yield* new StatusPagePersistenceError({
						message: "Created component not returned",
					})
				return toComponentRecord(created)
			})

			const updateComponent = Effect.fn("StatusPagesService.updateComponent")(function* (
				orgId: OrgId,
				componentId: StatusPageComponentId,
				patch: UpdateStatusPageComponentInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.component_id": componentId })
				const name = patch.name === undefined ? undefined : yield* validateName(patch.name, "Name")
				const description =
					patch.description === undefined
						? undefined
						: yield* validateText(patch.description, "Description")
				const groupName =
					patch.groupName === undefined
						? undefined
						: yield* validateText(patch.groupName, "Group name")
				const monitorId = patch.monitorId
				const now = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const current = yield* findComponent(db, orgId, componentId)
							yield* lockPage(db, orgId, current.pageId)
							if (monitorId !== undefined && monitorId !== null)
								yield* ensureMonitorInOrg(db, orgId, monitorId)
							const updated = yield* db.run(
								PG.update(StatusPageComponents)
									.set({
										...(name === undefined ? undefined : { name }),
										...(description === undefined ? undefined : { description }),
										...(groupName === undefined ? undefined : { groupName }),
										...(monitorId === undefined ? undefined : { monitorId }),
										...(patch.manualStatus === undefined
											? undefined
											: { manualStatus: patch.manualStatus }),
										...(patch.showUptime === undefined
											? undefined
											: { showUptime: patch.showUptime }),
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(componentId)])
									.returning(),
							)
							yield* bumpPage(db, orgId, current.pageId)
							return updated
						}),
					),
				)
				const row = rows[0]
				if (row === undefined) return yield* componentNotFound(componentId)
				return toComponentRecord(row)
			})

			const removeComponent = Effect.fn("StatusPagesService.removeComponent")(function* (
				orgId: OrgId,
				componentId: StatusPageComponentId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.component_id": componentId })
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const current = yield* findComponent(db, orgId, componentId)
							yield* lockPage(db, orgId, current.pageId)
							yield* db.run(
								PG.deleteFrom(StatusPageComponents).where(($) => [
									$.orgId.eq(orgId),
									$.id.eq(componentId),
								]),
							)
							yield* bumpPage(db, orgId, current.pageId)
						}),
					),
				)
				return componentId
			})

			const reorderComponents = Effect.fn("StatusPagesService.reorderComponents")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
				componentIds: ReadonlyArray<StatusPageComponentId>,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const now = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockPage(db, orgId, pageId)
							const existing = yield* selectComponents(db, orgId, pageId)
							const requested = new Set(componentIds)
							const sameSet =
								requested.size === componentIds.length &&
								requested.size === existing.length &&
								existing.every((row) => requested.has(row.id))
							if (!sameSet)
								return yield* invalid(
									"componentIds must list every component of the page exactly once",
								)
							yield* Effect.forEach(
								componentIds,
								(componentId, position) =>
									db.run(
										PG.update(StatusPageComponents)
											.set({ position, updatedAt: now })
											.where(($) => [
												$.orgId.eq(orgId),
												$.pageId.eq(pageId),
												$.id.eq(componentId),
											]),
									),
								{ discard: true },
							)
							yield* bumpPage(db, orgId, pageId)
							return yield* selectComponents(db, orgId, pageId)
						}),
					),
				)
				return rows.map(toComponentRecord)
			})

			const listIncidents = Effect.fn("StatusPagesService.listIncidents")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
				options?: ListStatusPageIncidentsOptions,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				const includeResolved = options?.includeResolved === true
				return yield* dbExecute((db) =>
					Effect.gen(function* () {
						yield* findPage(db, orgId, pageId)
						const rows = yield* db.run(
							PG.from(StatusPageIncidents)
								.select()
								.where(($) => [
									$.orgId.eq(orgId),
									$.pageId.eq(pageId),
									includeResolved ? undefined : $.resolvedAt.isNull(),
								])
								.orderBy(["startedAt", "desc"], ["id", "desc"])
								.limit(INCIDENT_LIST_LIMIT),
						)
						return yield* loadIncidents(db, orgId, rows)
					}),
				)
			})

			const listOrgIncidents = Effect.fn("StatusPagesService.listOrgIncidents")(function* (
				orgId: OrgId,
				options: ListOrgStatusPageIncidentsOptions,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const pageId = options.pageId
				return yield* dbExecute((db) =>
					Effect.gen(function* () {
						if (pageId !== null) yield* findPage(db, orgId, pageId)
						const rows = yield* db.run(
							PG.from(StatusPageIncidents)
								.select()
								.where(($) => [
									$.orgId.eq(orgId),
									pageId === null ? undefined : $.pageId.eq(pageId),
									options.state === "open"
										? $.resolvedAt.isNull()
										: options.state === "closed"
											? $.resolvedAt.isNotNull()
											: undefined,
								])
								.orderBy(["startedAt", "desc"], ["id", "desc"])
								.limit(options.limit)
								.offset(options.offset),
						)
						return yield* loadIncidents(db, orgId, rows)
					}),
				)
			})

			const getIncident = Effect.fn("StatusPagesService.getIncident")(function* (
				orgId: OrgId,
				incidentId: StatusPageIncidentId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.incident_id": incidentId })
				return yield* requireIncident(orgId, incidentId)
			})

			const createIncident = Effect.fn("StatusPagesService.createIncident")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
				input: CreateStatusPageIncidentInput,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.status_page.id": pageId,
					"maple.status_page.incident_kind": input.kind,
				})
				const title = yield* validateName(input.title, "Title")
				const body = yield* validateUpdateBody(input.body)
				const scheduledStart = input.scheduledStart ?? null
				const scheduledEnd = input.scheduledEnd ?? null
				yield* validateStatusForKind(input.kind, input.status)
				yield* validateWindow(input.kind, scheduledStart, scheduledEnd)
				const componentIds = [...new Set(input.componentIds)]
				const now = yield* Clock.currentTimeMillis
				const id = StatusPageIncidentId.make(randomUUID())
				const createdBy = input.createdBy ?? null
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* findPage(db, orgId, pageId)
							yield* ensureComponentsOnPage(db, orgId, pageId, componentIds)
							yield* db.run(
								PG.insertInto(StatusPageIncidents).values({
									id,
									orgId,
									pageId,
									kind: input.kind,
									title,
									impact: input.impact,
									status: input.status,
									published: input.published ?? true,
									alertIncidentId: null,
									scheduledStart,
									scheduledEnd,
									startedAt: scheduledStart ?? now,
									resolvedAt: isClosedStatus(input.status) ? now : null,
									createdBy,
									createdAt: now,
									updatedAt: now,
								}),
							)
							yield* db.run(
								PG.insertInto(StatusPageIncidentUpdates).values({
									id: StatusPageIncidentUpdateId.make(randomUUID()),
									orgId,
									incidentId: id,
									status: input.status,
									body,
									source: input.source,
									createdBy,
									overlayEntryId: null,
									createdAt: now,
								}),
							)
							yield* replaceIncidentComponents(db, orgId, id, componentIds)
							yield* bumpPage(db, orgId, pageId)
						}),
					),
				)
				return yield* requireIncident(orgId, id).pipe(
					Effect.catchTag("@maple/http/errors/StatusPageIncidentNotFoundError", () =>
						Effect.fail(
							new StatusPagePersistenceError({ message: "Created incident not found" }),
						),
					),
				)
			})

			const postUpdate = Effect.fn("StatusPagesService.postUpdate")(function* (
				orgId: OrgId,
				incidentId: StatusPageIncidentId,
				input: PostStatusPageIncidentUpdateInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.incident_id": incidentId })
				const body = yield* validateUpdateBody(input.body)
				const componentIds =
					input.componentIds === undefined ? undefined : [...new Set(input.componentIds)]
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const current = yield* findIncident(db, orgId, incidentId)
							yield* validateStatusForKind(current.kind, input.status)
							if (componentIds !== undefined)
								yield* ensureComponentsOnPage(db, orgId, current.pageId, componentIds)
							const closed = isClosedStatus(input.status)
							yield* db.run(
								PG.update(StatusPageIncidents)
									.set({
										status: input.status,
										...(input.impact === undefined
											? undefined
											: { impact: input.impact }),
										...(input.publish === true ? { published: true } : undefined),
										resolvedAt: closed ? (current.resolvedAt ?? now) : null,
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(incidentId)]),
							)
							yield* db.run(
								PG.insertInto(StatusPageIncidentUpdates).values({
									id: StatusPageIncidentUpdateId.make(randomUUID()),
									orgId,
									incidentId,
									status: input.status,
									body,
									source: input.source,
									createdBy: input.createdBy ?? null,
									overlayEntryId: null,
									createdAt: now,
								}),
							)
							if (componentIds !== undefined)
								yield* replaceIncidentComponents(db, orgId, incidentId, componentIds)
							yield* bumpPage(db, orgId, current.pageId)
						}),
					),
				)
				return yield* requireIncident(orgId, incidentId)
			})

			const updateIncident = Effect.fn("StatusPagesService.updateIncident")(function* (
				orgId: OrgId,
				incidentId: StatusPageIncidentId,
				patch: UpdateStatusPageIncidentInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.incident_id": incidentId })
				const title =
					patch.title === undefined ? undefined : yield* validateName(patch.title, "Title")
				const componentIds =
					patch.componentIds === undefined ? undefined : [...new Set(patch.componentIds)]
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const current = yield* findIncident(db, orgId, incidentId)
							const scheduledStart =
								patch.scheduledStart === undefined
									? current.scheduledStart
									: patch.scheduledStart
							const scheduledEnd =
								patch.scheduledEnd === undefined ? current.scheduledEnd : patch.scheduledEnd
							const windowChanged =
								patch.scheduledStart !== undefined || patch.scheduledEnd !== undefined
							if (windowChanged)
								yield* validateWindow(current.kind, scheduledStart, scheduledEnd)
							if (componentIds !== undefined)
								yield* ensureComponentsOnPage(db, orgId, current.pageId, componentIds)
							yield* db.run(
								PG.update(StatusPageIncidents)
									.set({
										...(title === undefined ? undefined : { title }),
										...(patch.impact === undefined
											? undefined
											: { impact: patch.impact }),
										...(patch.published === undefined
											? undefined
											: { published: patch.published }),
										...(windowChanged ? { scheduledStart, scheduledEnd } : undefined),
										...(windowChanged &&
										current.kind === "maintenance" &&
										scheduledStart !== null
											? { startedAt: scheduledStart }
											: undefined),
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(incidentId)]),
							)
							if (componentIds !== undefined)
								yield* replaceIncidentComponents(db, orgId, incidentId, componentIds)
							yield* bumpPage(db, orgId, current.pageId)
						}),
					),
				)
				return yield* requireIncident(orgId, incidentId)
			})

			const removeIncident = Effect.fn("StatusPagesService.removeIncident")(function* (
				orgId: OrgId,
				incidentId: StatusPageIncidentId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.incident_id": incidentId })
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const current = yield* findIncident(db, orgId, incidentId)
							yield* db.run(
								PG.deleteFrom(StatusPageIncidents).where(($) => [
									$.orgId.eq(orgId),
									$.id.eq(incidentId),
								]),
							)
							yield* bumpPage(db, orgId, current.pageId)
						}),
					),
				)
				return incidentId
			})

			const getConfig = Effect.fn("StatusPagesService.getConfig")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
				return yield* dbExecute((db) =>
					Effect.gen(function* () {
						const page = yield* findPage(db, orgId, pageId)
						return toConfig(page, yield* selectComponents(db, orgId, pageId))
					}),
				)
			})

			const applyConfig = Effect.fn("StatusPagesService.applyConfig")(function* (
				orgId: OrgId,
				pageId: StatusPageId,
				config: StatusPageConfig,
				actor: UserId,
				options?: { readonly ifVersion?: string | undefined },
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.status_page.id": pageId,
					"maple.status_page.actor": actor,
					"maple.status_page.config_components": config.components.length,
				})
				const input = normalizeStatusPageConfig(config)
				if (input.components.length > MAX_STATUS_PAGE_COMPONENTS) return yield* tooManyComponents()
				const name = yield* validateName(input.name, "Name")
				const slug = yield* validateSlug(input.slug)
				const description = yield* validateText(input.description, "Description")
				const websiteUrl = yield* validateHttpsUrl(input.website_url, "Website URL")
				const logoUrl = yield* validateHttpsUrl(input.logo_url, "Logo URL")
				const privacyUrl = yield* validateHttpsUrl(input.privacy_url, "Privacy policy URL")
				const termsUrl = yield* validateHttpsUrl(input.terms_url, "Terms of service URL")
				const theme = yield* validateTheme(input.theme)
				const components = yield* Effect.forEach(input.components, validateConfigComponent)
				const listedIds = components.flatMap((component) =>
					component.id === null ? [] : [component.id],
				)
				const duplicate = listedIds.find((id, index) => listedIds.indexOf(id) !== index)
				if (duplicate !== undefined)
					return yield* invalid(
						`Component ${encodeComponentId(duplicate)} is listed more than once`,
					)
				const monitorIds = [
					...new Set(components.flatMap((c) => (c.monitorId === null ? [] : [c.monitorId]))),
				]
				// The document as it will be stored; new components have no id yet.
				const written: StatusPageConfig = {
					name,
					slug,
					description,
					website_url: websiteUrl,
					logo_url: logoUrl,
					privacy_url: privacyUrl,
					terms_url: termsUrl,
					show_powered_by: input.show_powered_by,
					auto_incidents: input.auto_incidents,
					theme,
					components: components.map((component) => ({
						...(component.id === null ? undefined : { id: component.id }),
						name: component.name,
						description: component.description,
						group: component.groupName,
						monitor_id: component.monitorId,
						manual_status: component.manualStatus,
						show_uptime: component.showUptime,
					})),
				}
				const ifVersion = options?.ifVersion
				const now = yield* Clock.currentTimeMillis
				return yield* dbExecuteSlug(slug)((db) =>
					db.transaction(
						Effect.gen(function* () {
							// Locked before the components are read, so the change set below is the write's.
							const current = yield* lockPage(db, orgId, pageId)
							const existing = yield* selectComponents(db, orgId, pageId)
							const previous = toConfig(current, existing)
							const version = statusPageConfigVersion(previous)
							// The content's version, not the page revision: status flips and publishes leave it.
							if (ifVersion !== undefined && ifVersion !== version)
								return yield* new StatusPageConflictError({
									pageId,
									version,
									message:
										"The page's config changed since it was read. Read the config again and redo the edit on it.",
								})
							const byId = new Map(existing.map((row) => [row.id, row]))
							const foreign = listedIds.find((id) => !byId.has(id))
							if (foreign !== undefined)
								return yield* invalid(
									`Component ${encodeComponentId(foreign)} is not on this page`,
								)
							yield* ensureMonitorsInOrg(db, orgId, monitorIds)
							yield* ensureSlugFree(db, slug, pageId)
							const { fields, created, updated, deleted, reordered } = diffStatusPageConfig(
								previous,
								written,
							)
							// The old slug route stays at the edge until the publisher drains this.
							if (slug !== current.slug)
								yield* queueSlugRemoval(db, orgId, pageId, current.slug)
							yield* db.run(
								PG.update(StatusPages)
									.set({
										name,
										slug,
										description,
										websiteUrl,
										logoUrl,
										privacyUrl,
										termsUrl,
										theme,
										showPoweredBy: input.show_powered_by,
										autoIncidents: input.auto_incidents,
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)]),
							)
							const listed = new Set(listedIds)
							const [firstRemoved, ...restRemoved] = existing
								.filter((row) => !listed.has(row.id))
								.map((row) => row.id)
							if (firstRemoved !== undefined)
								yield* db.run(
									PG.deleteFrom(StatusPageComponents).where(($) => [
										$.orgId.eq(orgId),
										$.pageId.eq(pageId),
										$.id.in_(firstRemoved, ...restRemoved),
									]),
								)
							yield* Effect.forEach(
								components,
								(component, position) => {
									const fields = {
										name: component.name,
										description: component.description,
										groupName: component.groupName,
										position,
										monitorId: component.monitorId,
										manualStatus: component.manualStatus,
										showUptime: component.showUptime,
									}
									const previous =
										component.id === null ? undefined : byId.get(component.id)
									if (previous === undefined)
										return db.run(
											PG.insertInto(StatusPageComponents).values({
												...fields,
												id: StatusPageComponentId.make(randomUUID()),
												orgId,
												pageId,
												createdAt: now,
												updatedAt: now,
											}),
										)
									const unchanged =
										previous.name === fields.name &&
										previous.description === fields.description &&
										previous.groupName === fields.groupName &&
										previous.position === fields.position &&
										previous.monitorId === fields.monitorId &&
										previous.manualStatus === fields.manualStatus &&
										previous.showUptime === fields.showUptime
									return unchanged
										? Effect.void
										: db.run(
												PG.update(StatusPageComponents)
													.set({ ...fields, updatedAt: now })
													.where(($) => [
														$.orgId.eq(orgId),
														$.pageId.eq(pageId),
														$.id.eq(previous.id),
													]),
											)
								},
								{ discard: true },
							)
							// A document that changes nothing leaves the revision alone, so nothing is republished.
							if (hasStatusPageConfigChanges({ fields, created, updated, deleted, reordered }))
								yield* bumpPage(db, orgId, pageId)
							const page = yield* findPage(db, orgId, pageId)
							return {
								previous,
								config: toConfig(page, yield* selectComponents(db, orgId, pageId)),
								changes: { fields, created, updated, deleted, reordered },
							}
						}),
					),
				)
			})

			return {
				getConfig,
				applyConfig,
				list,
				get,
				create,
				update,
				remove,
				makePublic,
				rotateBreakGlassToken,
				revokeBreakGlassToken,
				listComponents,
				createComponent,
				updateComponent,
				removeComponent,
				reorderComponents,
				listIncidents,
				listOrgIncidents,
				getIncident,
				createIncident,
				postUpdate,
				updateIncident,
				removeIncident,
			} satisfies StatusPagesServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
