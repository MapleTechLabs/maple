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
import { STATUS_PAGE_BREAK_GLASS_PREFIX, StatusPageSlug, sha256Base64Url } from "@maple/domain/status-page"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { postgresSqlState } from "@maple/backend/platform/postgres-errors"
import { bumpPage } from "./outbox"

export interface CreateStatusPageInput {
	readonly name: string
	readonly slug: string
	readonly description?: string | null
	readonly websiteUrl?: string | null
	readonly logoUrl?: string | null
	readonly brandColor?: string | null
	readonly showPoweredBy?: boolean
	readonly autoIncidents?: StatusPageAutoIncidents
	readonly createdBy: UserId
}

export interface UpdateStatusPageInput {
	readonly name?: string
	readonly slug?: string
	readonly description?: string | null
	readonly websiteUrl?: string | null
	readonly logoUrl?: string | null
	readonly brandColor?: string | null
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
}

const MAX_NAME_LENGTH = 120
const MAX_TEXT_LENGTH = 2000
const MAX_URL_LENGTH = 2048
const BRAND_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u
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
	if (value.length > MAX_URL_LENGTH || !URL.canParse(value))
		return Effect.fail(invalid(`${what} must be a valid URL`))
	if (new URL(value).protocol !== "https:") return Effect.fail(invalid(`${what} must use https`))
	return Effect.succeed(value)
}

const validateBrandColor = (raw: string | null) => {
	if (raw === null) return Effect.succeed(null)
	return BRAND_COLOR_PATTERN.test(raw)
		? Effect.succeed(raw.toLowerCase())
		: Effect.fail(invalid("Brand color must be a hex color like #1a2b3c"))
}

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
	brandColor: row.brandColor,
	showPoweredBy: row.showPoweredBy,
	autoIncidents: row.autoIncidents,
	breakGlassTokenSuffix: row.breakGlassTokenSuffix,
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

const findPage = (db: MapleDb, orgId: OrgId, pageId: StatusPageId) =>
	db
		.run(
			PG.from(StatusPages)
				.select()
				.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)])
				.limit(1),
		)
		.pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined ? Effect.fail(pageNotFound(pageId)) : Effect.succeed(rows[0]),
			),
		)

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

const newBreakGlassToken = () => `${STATUS_PAGE_BREAK_GLASS_PREFIX}${randomBytes(32).toString("base64url")}`

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
				const brandColor = yield* validateBrandColor(input.brandColor ?? null)
				const now = yield* Clock.currentTimeMillis
				const id = StatusPageId.make(randomUUID())
				yield* dbExecuteSlug(slug)((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* ensureSlugFree(db, slug, null)
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
									brandColor,
									showPoweredBy: input.showPoweredBy ?? true,
									autoIncidents: input.autoIncidents ?? "off",
									breakGlassTokenSha256: null,
									breakGlassTokenSuffix: null,
									publishedAt: null,
									lastPublishError: null,
									createdBy: input.createdBy,
									createdAt: now,
									updatedAt: now,
								}),
							)
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
				const brandColor =
					patch.brandColor === undefined ? undefined : yield* validateBrandColor(patch.brandColor)
				const now = yield* Clock.currentTimeMillis
				yield* dbExecuteSlug(slug ?? "")((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* findPage(db, orgId, pageId)
							if (slug !== undefined) yield* ensureSlugFree(db, slug, pageId)
							yield* db.run(
								PG.update(StatusPages)
									.set({
										...(name === undefined ? undefined : { name }),
										...(slug === undefined ? undefined : { slug }),
										...(description === undefined ? undefined : { description }),
										...(websiteUrl === undefined ? undefined : { websiteUrl }),
										...(logoUrl === undefined ? undefined : { logoUrl }),
										...(brandColor === undefined ? undefined : { brandColor }),
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
					db.run(
						PG.deleteFrom(StatusPages)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)])
							.returning("id"),
					),
				)
				if (removed.length === 0) return yield* pageNotFound(pageId)
				return pageId
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
							yield* findPage(db, orgId, pageId)
							if (monitorId !== null) yield* ensureMonitorInOrg(db, orgId, monitorId)
							const existing = yield* selectComponents(db, orgId, pageId)
							const inserted = yield* db.run(
								PG.insertInto(StatusPageComponents)
									.values({
										id,
										orgId,
										pageId,
										name,
										description,
										groupName,
										position: existing.length,
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
							yield* findPage(db, orgId, pageId)
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
								.orderBy(["startedAt", "desc"], ["id", "desc"]),
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

			return {
				list,
				get,
				create,
				update,
				remove,
				rotateBreakGlassToken,
				revokeBreakGlassToken,
				listComponents,
				createComponent,
				updateComponent,
				removeComponent,
				reorderComponents,
				listIncidents,
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
