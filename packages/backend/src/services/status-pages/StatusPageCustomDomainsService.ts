import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	StatusPageCleanups,
	StatusPageCustomDomains,
	StatusPages,
	type StatusPageCustomDomainRow,
} from "@maple/db/tables"
import {
	StatusPageCustomDomainNotFoundError,
	StatusPageCustomDomainsUnavailableError,
	StatusPageCustomDomainTakenError,
	StatusPageNotFoundError,
	StatusPagePersistenceError,
	StatusPageValidationError,
} from "@maple/domain/http"
import {
	customDomainIssue,
	normalizeCustomDomain,
	type StatusPageCustomDomainDnsRecord,
} from "@maple/domain/status-page"
import type { OrgId, StatusPageCustomDomainStatus, StatusPageId } from "@maple/primitives"
import { Clock, Context, Effect, Layer, Option, Array as Arr } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { postgresSqlState } from "@maple/backend/platform/postgres-errors"
import {
	CloudflareCustomHostnames,
	type CustomHostnameState,
	type CustomHostnamesError,
} from "./CloudflareCustomHostnames"
import { bumpPage, queueCustomDomainRemoval } from "./outbox"

// A status page's custom domain through its Cloudflare for SaaS lifecycle: added (row first,
// Cloudflare second, so an outage only delays it), polled by the alerting tick or "Check now"
// until active, then routed by the publisher. Removing or replacing it queues the old one's
// teardown on the cleanup queue the publisher drains.

/** Domains one poll checks at most; the rest wait for the next minute. */
export const CUSTOM_DOMAIN_POLL_BATCH = 20
/** A new domain is checked every minute for its first hour, when the customer is setting DNS up. */
const FRESH_FOR_MS = 60 * 60_000
const FRESH_INTERVAL_MS = 60_000
/** After that, a pending domain is checked every ten minutes. */
const PENDING_INTERVAL_MS = 10 * 60_000
/** Active and failed domains are re-checked a few times a day, to notice a moved or expired one. */
const SETTLED_INTERVAL_MS = 6 * 60 * 60_000
const POLL_CONCURRENCY = 4

/** The custom domain section of a page: whether this deployment offers them, and the page's one. */
export interface StatusPageCustomDomainView {
	readonly pageId: StatusPageId
	readonly available: boolean
	readonly cnameTarget: string | null
	readonly domain: StatusPageCustomDomainRow | null
}

export interface StatusPageCustomDomainPollResult {
	readonly checked: number
	readonly activated: number
	readonly failed: number
}

type DomainError =
	| StatusPageNotFoundError
	| StatusPageValidationError
	| StatusPageCustomDomainTakenError
	| StatusPageCustomDomainsUnavailableError
	| StatusPagePersistenceError

export interface StatusPageCustomDomainsServiceApi {
	readonly get: (
		orgId: OrgId,
		pageId: StatusPageId,
	) => Effect.Effect<StatusPageCustomDomainView, StatusPageNotFoundError | StatusPagePersistenceError>
	/** Sets the page's domain, replacing a different one; setting the same hostname again changes nothing. */
	readonly set: (
		orgId: OrgId,
		pageId: StatusPageId,
		hostname: string,
	) => Effect.Effect<StatusPageCustomDomainView, DomainError>
	readonly remove: (
		orgId: OrgId,
		pageId: StatusPageId,
	) => Effect.Effect<
		StatusPageCustomDomainView,
		StatusPageNotFoundError | StatusPageCustomDomainNotFoundError | StatusPagePersistenceError
	>
	/** Asks Cloudflare again now (and to retry validation when it is not active yet). */
	readonly check: (
		orgId: OrgId,
		pageId: StatusPageId,
	) => Effect.Effect<
		StatusPageCustomDomainView,
		| StatusPageNotFoundError
		| StatusPageCustomDomainNotFoundError
		| StatusPageCustomDomainsUnavailableError
		| StatusPagePersistenceError
	>
	/** Checks domains whose next check is due. A failing one is recorded and skipped. */
	readonly poll: (
		nowMs: number,
	) => Effect.Effect<StatusPageCustomDomainPollResult, StatusPagePersistenceError>
}

/** Cloudflare hostname statuses that mean the hostname will not come up without someone acting. */
const FAILED_HOSTNAME_STATUSES: ReadonlySet<string> = new Set([
	"blocked",
	"pending_blocked",
	"moved",
	"deleted",
	"pending_deletion",
	"test_failed",
	"test_blocked",
])
const ACTIVE_HOSTNAME_STATUSES: ReadonlySet<string> = new Set(["active", "active_redeploying"])
/** A certificate in these states serves; `pending_expiration` is a renewal under way. */
const ACTIVE_SSL_STATUSES: ReadonlySet<string> = new Set(["active", "pending_expiration"])
const FAILED_SSL_STATUSES: ReadonlySet<string> = new Set([
	"initializing_timed_out",
	"validation_timed_out",
	"issuance_timed_out",
	"deployment_timed_out",
	"deletion_timed_out",
	"expired",
	"deleted",
	"inactive",
	"deactivating",
])

const HOSTNAME_STATUS_MESSAGE = new Map([
	["moved", "The hostname no longer points at Maple. Check its CNAME record."],
	["blocked", "Cloudflare blocked this hostname."],
	["pending_blocked", "Cloudflare blocked this hostname."],
	["deleted", "The hostname was removed at Cloudflare. Remove the domain and add it again."],
	["pending_deletion", "The hostname was removed at Cloudflare. Remove the domain and add it again."],
])

export interface CustomDomainProgress {
	readonly status: StatusPageCustomDomainStatus
	readonly dnsRecords: ReadonlyArray<StatusPageCustomDomainDnsRecord>
	readonly error: string | null
}

/** The CNAME every domain needs: the hostname, pointing at Maple's custom domain target. */
const routingRecord = (hostname: string, cnameTarget: string): StatusPageCustomDomainDnsRecord => ({
	type: "CNAME",
	name: hostname,
	value: cnameTarget,
	purpose: "routing",
})

/**
 * Where a domain stands from what Cloudflare says, and the DNS records to show: the CNAME always,
 * the ownership TXT until the hostname is verified, certificate TXTs while one is asked for. Once
 * active a domain stays active through a pending re-check; only a failure takes it down.
 */
export const customDomainProgress = (input: {
	readonly hostname: string
	readonly cnameTarget: string
	readonly previous: StatusPageCustomDomainStatus
	readonly state: CustomHostnameState
}): CustomDomainProgress => {
	const { state } = input
	const hostnameActive = ACTIVE_HOSTNAME_STATUSES.has(state.status)
	const sslActive = state.sslStatus !== null && ACTIVE_SSL_STATUSES.has(state.sslStatus)
	const records: Array<StatusPageCustomDomainDnsRecord> = [routingRecord(input.hostname, input.cnameTarget)]
	if (!hostnameActive && state.ownership !== null)
		records.push({ type: "TXT", ...state.ownership, purpose: "ownership" })
	if (!sslActive)
		for (const record of state.validationRecords)
			if (record.txtName !== null && record.txtValue !== null)
				records.push({
					type: "TXT",
					name: record.txtName,
					value: record.txtValue,
					purpose: "certificate",
				})
	const reported = state.errors[0] ?? null
	if (FAILED_HOSTNAME_STATUSES.has(state.status))
		return {
			status: "failed",
			dnsRecords: records,
			error:
				HOSTNAME_STATUS_MESSAGE.get(state.status) ??
				reported ??
				`Cloudflare reports ${state.status}.`,
		}
	if (state.sslStatus !== null && FAILED_SSL_STATUSES.has(state.sslStatus))
		return {
			status: "failed",
			dnsRecords: records,
			error:
				reported ??
				"The certificate was not issued in time. Check the CNAME record, then Check now to try again.",
		}
	if (hostnameActive && sslActive) return { status: "active", dnsRecords: records, error: null }
	const status = input.previous === "active" ? "active" : hostnameActive ? "pending_ssl" : "pending_dns"
	return { status, dnsRecords: records, error: reported }
}

const toPersistenceError = (error: unknown) =>
	new StatusPagePersistenceError({
		message: error instanceof Error ? error.message : "Custom domain persistence failed",
		cause: error,
	})

const unavailable = () =>
	new StatusPageCustomDomainsUnavailableError({
		message: "Custom domains are not configured on this deployment",
	})

const dueAfter = (row: StatusPageCustomDomainRow, nowMs: number) => {
	if (row.lastCheckedAt === null) return true
	const interval =
		row.status === "active" || row.status === "failed"
			? SETTLED_INTERVAL_MS
			: nowMs - row.createdAt < FRESH_FOR_MS
				? FRESH_INTERVAL_MS
				: PENDING_INTERVAL_MS
	return nowMs - row.lastCheckedAt >= interval
}

export class StatusPageCustomDomainsService extends Context.Service<
	StatusPageCustomDomainsService,
	StatusPageCustomDomainsServiceApi
>()("@maple/backend/services/status-pages/StatusPageCustomDomainsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const cloudflare = yield* CloudflareCustomHostnames
		const dbExecute = makeDbExecute(database, "StatusPageCustomDomainsService", toPersistenceError)
		const cnameTarget = Option.getOrNull(cloudflare.cnameTarget)

		const findPage = (db: MapleDb, orgId: OrgId, pageId: StatusPageId) =>
			db
				.run(
					PG.from(StatusPages)
						.select(($) => ({ id: $.id, visibility: $.visibility }))
						.where(($) => [$.orgId.eq(orgId), $.id.eq(pageId)])
						.limit(1)
						.forUpdate(),
				)
				.pipe(
					Effect.flatMap(([row]) =>
						row === undefined
							? Effect.fail(
									new StatusPageNotFoundError({ pageId, message: "Status page not found" }),
								)
							: Effect.succeed(row),
					),
				)

		const readDomain = (db: MapleDb, pageId: StatusPageId) =>
			db
				.run(
					PG.from(StatusPageCustomDomains)
						.select()
						.where(($) => [$.pageId.eq(pageId)])
						.limit(1),
				)
				.pipe(Effect.map(([row]) => row ?? null))

		const view = (
			pageId: StatusPageId,
			domain: StatusPageCustomDomainRow | null,
		): StatusPageCustomDomainView => ({
			pageId,
			available: cnameTarget !== null,
			cnameTarget,
			domain,
		})

		const load = (orgId: OrgId, pageId: StatusPageId) =>
			dbExecute((db) => findPage(db, orgId, pageId).pipe(Effect.andThen(readDomain(db, pageId))))

		/**
		 * Takes over the Cloudflare hostname and route of a removal of this same hostname still queued,
		 * so removing a domain and adding it back does not race its own teardown.
		 */
		const adoptQueued = (row: StatusPageCustomDomainRow) =>
			dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const [queued] = yield* db.run(
							PG.from(StatusPageCleanups)
								.select(($) => ({
									id: $.id,
									cloudflareHostnameId: $.cloudflareHostnameId,
									cloudflareRouteId: $.cloudflareRouteId,
								}))
								.where(($) => [
									$.hostname.eq(row.hostname),
									$.cloudflareHostnameId.isNotNull(),
								])
								.limit(1)
								.forUpdate(),
						)
						if (queued === undefined) return row
						yield* db.run(
							PG.update(StatusPageCleanups)
								.set({ cloudflareHostnameId: null, cloudflareRouteId: null })
								.where(($) => [$.id.eq(queued.id)]),
						)
						const [adopted] = yield* db.run(
							PG.update(StatusPageCustomDomains)
								.set({
									cloudflareHostnameId: queued.cloudflareHostnameId,
									cloudflareRouteId: queued.cloudflareRouteId,
								})
								.where(($) => [$.pageId.eq(row.pageId), $.hostname.eq(row.hostname)])
								.returning(),
						)
						return adopted ?? row
					}),
				),
			)

		/**
		 * Creates what is missing at Cloudflare, reads the hostname (asking it to validate again when
		 * `revalidate`), and records where the domain stands. A Cloudflare failure is recorded on the
		 * row as its last error, never raised: the next check tries again.
		 */
		const refresh = (row: StatusPageCustomDomainRow, options: { readonly revalidate: boolean }) =>
			Effect.gen(function* () {
				const nowMs = yield* Clock.currentTimeMillis
				const target = cnameTarget ?? row.hostname
				const current = row.cloudflareHostnameId === null ? yield* adoptQueued(row) : row
				const recordUnreachable = (error: CustomHostnamesError) =>
					Effect.logWarning("Custom domain check failed").pipe(
						Effect.annotateLogs({
							"maple.status_page.id": current.pageId,
							"error.message": error.message,
						}),
						Effect.as({
							hostnameId: current.cloudflareHostnameId,
							routeId: current.cloudflareRouteId,
							status: current.status,
							dnsRecords:
								current.dnsRecords.length === 0
									? [routingRecord(current.hostname, target)]
									: current.dnsRecords,
							error: "Maple could not reach Cloudflare to check this domain. It tries again shortly.",
						}),
					)
				const progress = yield* Effect.gen(function* () {
					let hostnameId = current.cloudflareHostnameId
					let routeId = current.cloudflareRouteId
					let state: CustomHostnameState | null = null
					if (hostnameId !== null) {
						const read = yield* options.revalidate && current.status !== "active"
							? cloudflare.revalidateHostname(hostnameId)
							: cloudflare.getHostname(hostnameId)
						// Removed at Cloudflare (or by a teardown we raced): start over with a new one.
						if (Option.isNone(read)) {
							hostnameId = null
							routeId = null
						} else state = read.value
					}
					if (state === null) {
						state = yield* cloudflare.createHostname(current.hostname)
						hostnameId = state.id
					}
					if (routeId === null) routeId = yield* cloudflare.createRoute(current.hostname)
					return {
						hostnameId,
						routeId,
						...customDomainProgress({
							hostname: current.hostname,
							cnameTarget: target,
							previous: current.status,
							state,
						}),
					}
				}).pipe(
					Effect.catchTags({
						"@maple/backend/status-pages/CustomHostnameConflictError": () =>
							Effect.succeed({
								hostnameId: null,
								routeId: current.cloudflareRouteId,
								status: "failed" as const,
								dnsRecords: [routingRecord(current.hostname, target)],
								error: "This hostname is already set up with Cloudflare for another service. Remove it there, then Check now.",
							}),
						"@maple/backend/status-pages/CustomHostnamesNotConfiguredError": recordUnreachable,
						"@maple/backend/status-pages/CustomHostnamesApiError": recordUnreachable,
					}),
				)
				const activated = progress.status === "active" && current.status !== "active"
				const changedServing = (progress.status === "active") !== (current.status === "active")
				const saved = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const [updated] = yield* db.run(
								PG.update(StatusPageCustomDomains)
									.set({
										status: progress.status,
										cloudflareHostnameId: progress.hostnameId,
										cloudflareRouteId: progress.routeId,
										dnsRecords: progress.dnsRecords,
										lastError: progress.error,
										lastCheckedAt: nowMs,
										...(activated && current.activatedAt === null
											? { activatedAt: nowMs }
											: undefined),
										updatedAt: nowMs,
									})
									.where(($) => [
										$.pageId.eq(current.pageId),
										$.hostname.eq(current.hostname),
									])
									.returning(),
							)
							if (updated === undefined) {
								// Replaced or removed while we talked to Cloudflare: what we created goes too.
								const created = {
									hostname: current.hostname,
									cloudflareHostnameId:
										progress.hostnameId === current.cloudflareHostnameId
											? null
											: progress.hostnameId,
									cloudflareRouteId:
										progress.routeId === current.cloudflareRouteId
											? null
											: progress.routeId,
								}
								if (
									created.cloudflareHostnameId !== null ||
									created.cloudflareRouteId !== null
								)
									yield* queueCustomDomainRemoval(
										db,
										current.orgId,
										current.pageId,
										created,
									)
								return null
							}
							// The page's canonical address and edge route follow the domain going live or down.
							if (changedServing) yield* bumpPage(db, current.orgId, current.pageId)
							return updated
						}),
					),
				)
				return { row: saved, activated, failed: progress.status === "failed" }
			})

		const get = Effect.fn("StatusPageCustomDomainsService.get")(function* (
			orgId: OrgId,
			pageId: StatusPageId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
			const domain = yield* load(orgId, pageId)
			return view(pageId, domain)
		})

		const set = Effect.fn("StatusPageCustomDomainsService.set")(function* (
			orgId: OrgId,
			pageId: StatusPageId,
			raw: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
			if (cnameTarget === null) return yield* unavailable()
			const hostname = normalizeCustomDomain(raw)
			const issue = customDomainIssue(hostname)
			if (issue !== null) return yield* new StatusPageValidationError({ message: issue })
			yield* Effect.annotateCurrentSpan({ "maple.status_page.custom_domain": hostname })
			const nowMs = yield* Clock.currentTimeMillis
			const taken = () =>
				new StatusPageCustomDomainTakenError({
					hostname,
					message: `${hostname} is already used by another status page`,
				})
			const inserted = yield* makeDbExecute(
				database,
				"StatusPageCustomDomainsService",
				(error: DatabaseError) =>
					postgresSqlState(error) === "23505" ? taken() : toPersistenceError(error),
			)((db) =>
				db.transaction(
					Effect.gen(function* () {
						const page = yield* findPage(db, orgId, pageId)
						// Locked with the page, so it cannot go internal while the domain is added.
						if (page.visibility === "internal")
							return yield* new StatusPageValidationError({
								message:
									"An internal page is served on no address, so it cannot have a custom domain. Make it public or password-protected first.",
							})
						const existing = yield* readDomain(db, pageId)
						if (existing?.hostname === hostname) return null
						const [owner] = yield* db.run(
							PG.from(StatusPageCustomDomains)
								.select(($) => ({ pageId: $.pageId }))
								.where(($) => [$.hostname.eq(hostname)])
								.limit(1),
						)
						if (owner !== undefined) return yield* taken()
						if (existing !== null) {
							yield* queueCustomDomainRemoval(db, orgId, pageId, existing)
							yield* db.run(
								PG.deleteFrom(StatusPageCustomDomains).where(($) => [$.pageId.eq(pageId)]),
							)
							if (existing.status === "active") yield* bumpPage(db, orgId, pageId)
						}
						const [row] = yield* db.run(
							PG.insertInto(StatusPageCustomDomains)
								.values({
									pageId,
									orgId,
									hostname,
									status: "pending_dns",
									cloudflareHostnameId: null,
									cloudflareRouteId: null,
									dnsRecords: [routingRecord(hostname, cnameTarget)],
									lastError: null,
									lastCheckedAt: null,
									activatedAt: null,
									createdAt: nowMs,
									updatedAt: nowMs,
								})
								.returning(),
						)
						return row ?? null
					}),
				),
			)
			if (inserted === null) {
				const current = yield* load(orgId, pageId)
				return view(pageId, current)
			}
			const refreshed = yield* refresh(inserted, { revalidate: false })
			return view(pageId, refreshed.row ?? (yield* load(orgId, pageId)))
		})

		const remove = Effect.fn("StatusPageCustomDomainsService.remove")(function* (
			orgId: OrgId,
			pageId: StatusPageId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* findPage(db, orgId, pageId)
						const existing = yield* readDomain(db, pageId)
						if (existing === null)
							return yield* new StatusPageCustomDomainNotFoundError({
								pageId,
								message: "This status page has no custom domain",
							})
						// The publisher takes it down at Cloudflare and at the edge on its next sweep.
						yield* queueCustomDomainRemoval(db, orgId, pageId, existing)
						yield* db.run(
							PG.deleteFrom(StatusPageCustomDomains).where(($) => [$.pageId.eq(pageId)]),
						)
						if (existing.status === "active") yield* bumpPage(db, orgId, pageId)
					}),
				),
			)
			return view(pageId, null)
		})

		const check = Effect.fn("StatusPageCustomDomainsService.check")(function* (
			orgId: OrgId,
			pageId: StatusPageId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.status_page.id": pageId })
			if (cnameTarget === null) return yield* unavailable()
			const existing = yield* load(orgId, pageId)
			if (existing === null)
				return yield* new StatusPageCustomDomainNotFoundError({
					pageId,
					message: "This status page has no custom domain",
				})
			const refreshed = yield* refresh(existing, { revalidate: true })
			return view(pageId, refreshed.row ?? (yield* load(orgId, pageId)))
		})

		const poll = Effect.fn("StatusPageCustomDomainsService.poll")(function* (nowMs: number) {
			const empty = { checked: 0, activated: 0, failed: 0 }
			if (cnameTarget === null) return empty
			// Oldest check first, never-checked before all; the interval per status is applied here.
			const candidates = yield* dbExecute((db) =>
				db.run(
					PG.from(StatusPageCustomDomains)
						.select()
						.where(($) => [
							PG.or($.lastCheckedAt.isNull(), $.lastCheckedAt.lte(nowMs - FRESH_INTERVAL_MS)),
						])
						.orderBy(($) => [
							[PG.asBoolean($.lastCheckedAt.isNotNull()), "asc"],
							[$.lastCheckedAt, "asc"],
							[$.pageId, "asc"],
						])
						.limit(CUSTOM_DOMAIN_POLL_BATCH * 5),
				),
			)
			const due = Arr.take(
				Arr.filter(candidates, (row) => dueAfter(row, nowMs)),
				CUSTOM_DOMAIN_POLL_BATCH,
			)
			const outcomes = yield* Effect.forEach(
				due,
				(row) =>
					refresh(row, { revalidate: false }).pipe(
						Effect.map((outcome) => ({ ...outcome, ok: true })),
						Effect.catch((error) =>
							Effect.logWarning("Custom domain poll failed").pipe(
								Effect.annotateLogs({
									"maple.status_page.id": row.pageId,
									"error.type": error._tag,
									"error.message": error.message,
								}),
								Effect.as({ row: null, activated: false, failed: false, ok: false }),
							),
						),
					),
				{ concurrency: POLL_CONCURRENCY },
			)
			const result = {
				checked: Arr.filter(outcomes, (outcome) => outcome.ok).length,
				activated: Arr.filter(outcomes, (outcome) => outcome.activated).length,
				failed: Arr.filter(outcomes, (outcome) => outcome.failed).length,
			}
			yield* Effect.annotateCurrentSpan({
				"maple.status_page.custom_domains_checked": result.checked,
				"maple.status_page.custom_domains_activated": result.activated,
			})
			return result
		})

		return { get, set, remove, check, poll } satisfies StatusPageCustomDomainsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(CloudflareCustomHostnames.layer))
}

export type { CustomHostnamesError }
