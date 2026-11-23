/**
 * Fleet as a device source: each server's failing policies at every level and its vulnerable
 * software, synced hourly under the connection's findings lease. A sync replaces the server's
 * findings: a policy every device passes again, or a CVE no longer installed, drops out.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { type FleetConnectionRow, FleetConnections } from "@maple/db/tables"
import type { DeviceRef } from "@maple/domain/device-security"
import { IntegrationsPersistenceError, type OrgId } from "@maple/domain/http"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { openSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { fleetTokenSlot } from "@maple/backend/platform/secret-slots"
import {
	type DeviceSourceStatus,
	type DeviceSourceStatusReader,
	replaceDeviceFindings,
} from "@maple/backend/services/device-security/device-findings-store"
import { leaseStillOurs } from "./lease"
import { type Lease, type LeaseSpec, leaseFree, withLease } from "./poller"
import * as FleetApi from "./fleet/api"
import {
	type FleetScopedPolicy,
	failingPolicies,
	findingDevice,
	vulnerabilitiesByCve,
	vulnerabilitiesBySoftware,
} from "./fleet/findings"

const SYNC_EVERY_MS = 60 * 60_000
/** A failed sync (the server down, an error, a refused read) waits this long, not the next tick. */
const FAILED_SYNC_HOLD_MS = 15 * 60_000
const LEASE_MS = 4 * 60_000
/** After this long in a lane, no new server starts: the lane ends at 270 seconds. */
const START_BY_MS = 150_000
/** Failing devices kept per policy, and policies sampled per sync. */
const HOSTS_PER_POLICY = 20
const SAMPLED_POLICIES = 100
const SOFTWARE_PAGE_SIZE = 100
const MAX_SOFTWARE_PAGES = 10
const CVE_PAGE_SIZE = 100
const MAX_CVE_PAGES = 10
const POLICY_PAGE_SIZE = 500
const MAX_POLICY_PAGES = 10
const FLEET_PAGE_SIZE = 500
/** Fleets whose policies one sync reads, a request each: what fits the lane's time two at a time. */
const MAX_FLEETS = 1_000
/** What Fleet calls the devices in no fleet. */
const UNASSIGNED = "Unassigned"

/** A listed fleet whose policies answer 404: deleted since, not a wrong address. */
const fleetGone = (name: string, error: FleetApi.FleetApiError) =>
	new FleetApi.FleetApiError({
		message: `Fleet no longer has "${name}", which it listed a moment ago. The next sync reads the fleets it has then.`,
		kind: error.kind,
		status: 404,
	})

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Fleet findings persistence failure",
)

export interface FleetFindingsSyncResult {
	readonly connections: number
	readonly failedConnections: number
	readonly policies: number
	readonly vulnerabilities: number
}

/** How one server's sync ended. */
interface ServerOutcome {
	readonly failed: boolean
	readonly policies: number
	readonly vulnerabilities: number
}

/** The org's Fleet server as a device source, for the Devices page; empty when none is connected. */
export interface FleetFindingsServiceApi extends DeviceSourceStatusReader {
	/** Syncs every server whose findings are an hour old, or never synced. */
	readonly syncDue: Effect.Effect<FleetFindingsSyncResult, IntegrationsPersistenceError>
}

export class FleetFindingsService extends Context.Service<FleetFindingsService, FleetFindingsServiceApi>()(
	"@maple/backend/services/integrations/FleetFindingsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const keyring = yield* secretKeyringFromEnv(
				env,
				(message) => new IntegrationsPersistenceError({ message }),
			)
			const dbExecute = makeDbExecute(database, "FleetFindingsService", toPersistenceError)

			type FindingsSet = PG.UpdateSetOf<typeof FleetConnections>
			type FindingsLease = Lease<FleetConnectionRow, FindingsSet, IntegrationsPersistenceError>

			/** Still this tick's: its findings lease, and the token it read with. */
			const stillOurs =
				(claimed: FleetConnectionRow) => ($: PG.ColumnAccessor<typeof FleetConnections.columns>) => [
					$.id.eq(claimed.id),
					leaseStillOurs($.findingsLeaseUntil, claimed.findingsLeaseUntil),
					$.tokenCiphertext.eq(claimed.tokenCiphertext),
				]

			const findingsLease = (
				connectionId: string,
			): LeaseSpec<FleetConnectionRow, FindingsSet, IntegrationsPersistenceError> => ({
				leaseMs: LEASE_MS,
				claim: (leaseUntil, now) =>
					dbExecute((db) =>
						db.run(
							PG.update(FleetConnections)
								.set({ findingsLeaseUntil: leaseUntil })
								.where(($) => [
									$.id.eq(connectionId),
									$.authFailedAt.isNull(),
									leaseFree($.findingsLeaseUntil, $.findingsHoldUntil, now, LEASE_MS),
								])
								.returning(),
						),
					).pipe(Effect.map((rows) => rows[0] ?? null)),
				write: (claimed, set) =>
					dbExecute((db) =>
						db.run(
							PG.update(FleetConnections).set(set).where(stillOurs(claimed)).returning("id"),
						),
					).pipe(Effect.map((rows) => rows.length > 0)),
				release: (holdUntil) => ({ findingsLeaseUntil: null, findingsHoldUntil: holdUntil }),
				// A token saved mid-sync still gets the row back.
				releaseWrite: (claimed, set) =>
					dbExecute((db) =>
						db.run(
							PG.update(FleetConnections)
								.set(set)
								.where(($) => [
									$.id.eq(claimed.id),
									leaseStillOurs($.findingsLeaseUntil, claimed.findingsLeaseUntil),
								])
								.returning("id"),
						),
					).pipe(Effect.map((rows) => rows.length > 0)),
			})

			/** The most installed vulnerable versions, and whether that was all of them. */
			const readSoftware = (
				fleet: FleetApi.FleetClient,
				page: number,
				acc: ReadonlyArray<FleetApi.FleetSoftwareVersion>,
			): Effect.Effect<
				{
					readonly software: ReadonlyArray<FleetApi.FleetSoftwareVersion>
					readonly complete: boolean
				},
				FleetApi.FleetApiError
			> =>
				FleetApi.listVulnerableSoftware(fleet, page, SOFTWARE_PAGE_SIZE).pipe(
					Effect.flatMap((answer) => {
						const all = Arr.appendAll(acc, answer.software ?? [])
						// Only an explicit last page is complete: a page without `meta` may have more after it.
						const hasNext = answer.meta?.has_next_results
						return hasNext === true && page + 1 < MAX_SOFTWARE_PAGES
							? readSoftware(fleet, page + 1, all)
							: Effect.succeed({ software: all, complete: hasNext === false })
					}),
				)

			/**
			 * Every row of a paged list. Fleet's docs give these lists no default page size and no
			 * `meta`, so pages are asked for explicitly until a short one, or one with nothing new (a
			 * server ignoring paging).
			 */
			const readAll = <A extends { readonly id: number }>(
				readPage: (page: number) => Effect.Effect<ReadonlyArray<A>, FleetApi.FleetApiError>,
				pageSize: number,
				maxPages: number,
				page = 0,
				acc: ReadonlyArray<A> = [],
			): Effect.Effect<ReadonlyArray<A>, FleetApi.FleetApiError> =>
				readPage(page).pipe(
					Effect.flatMap((rows) => {
						const seen = new Set(Arr.map(acc, (row) => row.id))
						const added = Arr.filter(rows, (row) => !seen.has(row.id))
						const all = Arr.appendAll(acc, added)
						return added.length < pageSize || page + 1 >= maxPages
							? Effect.succeed(all)
							: readAll(readPage, pageSize, maxPages, page + 1, all)
					}),
				)

			/** The server's fleets; none on Fleet Free, which has no fleets and answers 402. */
			const readFleets = (
				fleet: FleetApi.FleetClient,
				dialect: FleetApi.FleetDialect,
			): Effect.Effect<Option.Option<ReadonlyArray<FleetApi.FleetGroup>>, FleetApi.FleetApiError> =>
				readAll(
					(page) => FleetApi.listFleets(fleet, dialect, page, FLEET_PAGE_SIZE),
					FLEET_PAGE_SIZE,
					// One page past the cap, to tell a server at the cap from one over it.
					MAX_FLEETS / FLEET_PAGE_SIZE + 1,
				).pipe(
					// Reading only some fleets would show the rest as passing: the sync fails instead.
					Effect.filterOrFail(
						(found) => found.length <= MAX_FLEETS,
						(found) =>
							new FleetApi.FleetApiError({
								// A read that filled every page it may ask for counted only up to there.
								message: `This Fleet server has ${found.length >= MAX_FLEETS + FLEET_PAGE_SIZE ? "at least " : ""}${found.length} fleets. Maple reads the policies of at most ${MAX_FLEETS}.`,
								kind: "upstream",
							}),
					),
					Effect.asSome,
					Effect.catchIf(
						(error) => error.status === 402,
						() => Effect.succeedNone,
					),
				)

			/**
			 * Every policy on the server with the fleet it belongs to: the global ones, each fleet's, and
			 * those of devices in no fleet. Most servers keep their policies on fleets, not globally.
			 */
			const readPolicies = Effect.fnUntraced(function* (
				fleet: FleetApi.FleetClient,
				dialect: FleetApi.FleetDialect,
			) {
				const policiesOf = (scope: FleetApi.PolicyScope) =>
					readAll(
						(page) => FleetApi.listPolicies(fleet, dialect, scope, page, POLICY_PAGE_SIZE),
						POLICY_PAGE_SIZE,
						MAX_POLICY_PAGES,
					)
				// Two requests at a time: two servers sync at once, and a Worker holds six connections.
				const [global, fleets] = yield* Effect.all(
					[policiesOf({ _tag: "Global" }), readFleets(fleet, dialect)],
					{ concurrency: 2 },
				)
				yield* Effect.annotateCurrentSpan(
					"maple.fleet.fleets",
					Option.match(fleets, { onNone: () => 0, onSome: (found) => found.length }),
				)
				const groups: ReadonlyArray<{ readonly scope: FleetApi.PolicyScope; readonly name: string }> =
					Option.match(fleets, {
						onNone: () => [],
						onSome: (found) => [
							...(dialect.unassigned
								? [{ scope: { _tag: "Unassigned" as const }, name: UNASSIGNED }]
								: []),
							...Arr.map(found, (group) => ({
								scope: { _tag: "Fleet" as const, id: group.id },
								name: group.name,
							})),
						],
					})
				// A fleet that cannot be read fails the sync: reading it as empty would resolve its findings.
				const grouped = yield* Effect.forEach(
					groups,
					(group) =>
						policiesOf(group.scope).pipe(
							Effect.mapBoth({
								onFailure: (error) =>
									error.status === 404 ? fleetGone(group.name, error) : error,
								onSuccess: (policies) =>
									Arr.map(policies, (policy): FleetScopedPolicy => ({
										policy,
										groupName: group.name,
									})),
							}),
						),
					{ concurrency: 2 },
				)
				const all: ReadonlyArray<FleetScopedPolicy> = Arr.appendAll(
					Arr.map(global, (policy) => ({ policy, groupName: null })),
					Arr.flatten(grouped),
				)
				// A policy id is one stored row. Should a fleet's read repeat a global policy, the global one stays.
				const byId = new Map(Arr.map(Arr.reverse(all), (scoped) => [scoped.policy.id, scoped]))
				return Arr.fromIterable(byId.values())
			})

			/** The first dialect whose paths this server has: the next is tried on a 404 or a 410. */
			const readPoliciesIn = (
				fleet: FleetApi.FleetClient,
				[dialect, ...others]: Arr.NonEmptyReadonlyArray<FleetApi.FleetDialect>,
			): Effect.Effect<ReadonlyArray<FleetScopedPolicy>, FleetApi.FleetApiError> =>
				Arr.isReadonlyArrayNonEmpty(others)
					? readPolicies(fleet, dialect).pipe(
							Effect.catchIf(
								(error) => error.status === 404 || error.status === 410,
								() => readPoliciesIn(fleet, others),
							),
						)
					: readPolicies(fleet, dialect)

			/**
			 * Fleet's CVEs, on the most devices first, and its total. None from a server older than
			 * `/vulnerabilities` (a 404), which falls back to reading CVEs off the software.
			 */
			const readCves = (
				fleet: FleetApi.FleetClient,
				page: number,
				acc: ReadonlyArray<FleetApi.FleetCve>,
			): Effect.Effect<
				Option.Option<{
					readonly cves: ReadonlyArray<FleetApi.FleetCve>
					readonly complete: boolean
					readonly total: number | null
				}>,
				FleetApi.FleetApiError
			> =>
				FleetApi.listVulnerabilities(fleet, page, CVE_PAGE_SIZE).pipe(
					Effect.flatMap((answer) => {
						const all = Arr.appendAll(acc, answer.vulnerabilities ?? [])
						const hasNext = answer.meta?.has_next_results
						return hasNext === true && page + 1 < MAX_CVE_PAGES
							? readCves(fleet, page + 1, all)
							: Effect.succeedSome({
									cves: all,
									complete: hasNext === false,
									total: answer.count ?? null,
								})
					}),
					Effect.catchIf(
						(error) => page === 0 && error.status === 404,
						() => Effect.succeedNone,
					),
				)

			/** What the server reports now: counts, failing policies with sample devices, CVEs. */
			const read = Effect.fnUntraced(function* (fleet: FleetApi.FleetClient, baseUrl: string) {
				// The version first: it decides where this server keeps its policies and fleets.
				const [{ version }, hosts] = yield* Effect.all(
					[FleetApi.getVersion(fleet), FleetApi.countHosts(fleet)],
					{ concurrency: 2 },
				)
				const policies = yield* readPoliciesIn(fleet, FleetApi.fleetDialectsOf(version))
				const failing = failingPolicies(policies, baseUrl)
				const samples = yield* Effect.forEach(
					Arr.take(failing, SAMPLED_POLICIES),
					(policy) =>
						FleetApi.listFailingHosts(fleet, policy.numericId, HOSTS_PER_POLICY).pipe(
							Effect.map(
								(page) =>
									[
										policy.numericId,
										Arr.map(page.hosts ?? [], (host) => findingDevice(host, baseUrl)),
									] as const,
							),
						),
					{ concurrency: 2 },
				)
				const sampled = new Map<number, ReadonlyArray<DeviceRef>>(samples)
				const [read, counted] = yield* Effect.all(
					[readSoftware(fleet, 0, []), readCves(fleet, 0, [])],
					{ concurrency: 2 },
				)
				const fromFleet = Option.isSome(counted)
				return {
					serverVersion: version,
					deviceCount: hosts.count,
					policies: Arr.map(failing, (policy) => ({
						...policy.finding,
						failingDevices: sampled.get(policy.numericId) ?? [],
					})),
					// Fleet's own CVE rows count each device once; software alone is the fallback.
					vulnerabilities: Option.match(counted, {
						onNone: () => vulnerabilitiesBySoftware(read.software, baseUrl),
						onSome: ({ cves }) => vulnerabilitiesByCve(cves, read.software, baseUrl),
					}),
					vulnerabilitiesComplete: fromFleet ? counted.value.complete : read.complete,
					vulnerabilityCount: fromFleet ? counted.value.total : null,
				}
			})

			/**
			 * Replaces the server's findings with what it reports now, in one transaction that first
			 * proves the lease is still this tick's. False, and nothing written, once it is not.
			 */
			const store = (
				claimed: FleetConnectionRow,
				now: number,
				snapshot: Effect.Success<ReturnType<typeof read>>,
			) =>
				dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const owned = yield* db.run(
								PG.update(FleetConnections)
									.set({
										findingsSyncedAt: now,
										findingsError: null,
										findingsErrorAt: null,
										// An upgraded server shows its new version without a reconnect.
										serverVersion: snapshot.serverVersion,
										deviceCount: snapshot.deviceCount,
										vulnerabilityCount: snapshot.vulnerabilityCount,
									})
									.where(stillOurs(claimed))
									.returning("id"),
							)
							if (owned.length === 0) return false
							yield* replaceDeviceFindings(
								db,
								{ orgId: claimed.orgId, source: "fleet", connectionId: claimed.id },
								now,
								snapshot,
							)
							return true
						}),
					),
				)

			const NOTHING: ServerOutcome = { failed: false, policies: 0, vulnerabilities: 0 }
			const FAILED: ServerOutcome = { failed: true, policies: 0, vulnerabilities: 0 }

			const syncClaimed = Effect.fn("FleetFindingsService.syncServer")(function* (
				lease: FindingsLease,
			) {
				const { row: claimed, now } = lease
				yield* Effect.annotateCurrentSpan({
					orgId: claimed.orgId,
					"maple.fleet.connection_id": claimed.id,
				})
				const fail = (message: string, extra: FindingsSet = {}) =>
					lease
						.write({ findingsError: message, findingsErrorAt: now, ...extra })
						.pipe(Effect.as(FAILED))

				const token = yield* Effect.result(
					openSecret(
						keyring,
						fleetTokenSlot,
						{ orgId: claimed.orgId, baseUrl: claimed.baseUrl },
						{ ciphertext: claimed.tokenCiphertext, iv: claimed.tokenIv, tag: claimed.tokenTag },
						(message) => new IntegrationsPersistenceError({ message }),
					),
				)
				if (token._tag === "Failure")
					return yield* fail("The stored Fleet token could not be opened. Save it again.")
				const snapshot = yield* Effect.result(
					FleetApi.fleetClient(httpClient, {
						baseUrl: claimed.baseUrl,
						token: Redacted.make(token.success),
					}).pipe(Effect.flatMap((fleet) => read(fleet, claimed.baseUrl))),
				)
				if (snapshot._tag === "Failure") {
					const failure = snapshot.failure
					yield* Effect.annotateCurrentSpan("maple.fleet.error_kind", failure.kind)
					switch (failure.kind) {
						// Both readers stop until a new token is saved.
						case "unauthorized":
							return yield* fail(failure.message, {
								authFailedAt: now,
								lastError: failure.message,
								lastErrorAt: now,
							})
						case "rate_limited":
							yield* lease.holdFor({
								_tag: "RateLimited",
								message: failure.message,
								retryAfterMs: (failure.retryAfterSeconds ?? 0) * 1000,
							})
							return yield* fail(failure.message)
						default:
							yield* lease.hold(now + FAILED_SYNC_HOLD_MS)
							return yield* fail(failure.message)
					}
				}
				// Its own span, so a failed write ends that span in Error with the exception on it.
				const stored = yield* Effect.result(
					store(claimed, now, snapshot.success).pipe(Effect.withSpan("FleetFindingsService.store")),
				)
				if (stored._tag === "Failure") {
					yield* Effect.annotateCurrentSpan("maple.fleet.error_kind", "store")
					// The read is redone from scratch, so a write that keeps failing waits like any failure.
					yield* lease.hold(now + FAILED_SYNC_HOLD_MS)
					yield* Effect.logWarning("Fleet findings could not be stored").pipe(
						Effect.annotateLogs({
							connectionId: claimed.id,
							error: stored.failure.message,
							cause: stored.failure.cause ?? null,
						}),
					)
					return yield* fail(
						"Findings were read from Fleet but could not be saved. Maple retries next tick.",
					)
				}
				if (!stored.success) return NOTHING
				yield* Effect.annotateCurrentSpan({
					"maple.fleet.policies": snapshot.success.policies.length,
					"maple.fleet.vulnerabilities": snapshot.success.vulnerabilities.length,
				})
				return {
					failed: false,
					policies: snapshot.success.policies.length,
					vulnerabilities: snapshot.success.vulnerabilities.length,
				} satisfies ServerOutcome
			})

			const syncDue = Effect.gen(function* () {
				const startedAt = yield* Clock.currentTimeMillis
				const due = yield* dbExecute((db) =>
					db.run(
						PG.from(FleetConnections)
							.select("id")
							.where(($) => [
								$.authFailedAt.isNull(),
								PG.or(
									$.findingsSyncedAt.isNull(),
									$.findingsSyncedAt.lte(startedAt - SYNC_EVERY_MS),
								),
							]),
					),
				)
				const outcomes = yield* Effect.forEach(
					due,
					(candidate) =>
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis
							// Late in the lane, a new server waits for the next tick rather than be cut short.
							if (now - startedAt > START_BY_MS) return Option.none<ServerOutcome>()
							return yield* withLease(findingsLease(candidate.id), now, syncClaimed)
						}).pipe(
							// One server's broken row never stops the others.
							Effect.catch((error) =>
								Effect.logWarning("Fleet findings sync failed").pipe(
									Effect.annotateLogs({ connectionId: candidate.id, error }),
									Effect.as(Option.some(FAILED)),
								),
							),
						),
					{ concurrency: 2 },
				)
				const synced = Arr.getSomes(outcomes)
				return {
					connections: synced.length,
					failedConnections: Arr.filter(synced, (outcome) => outcome.failed).length,
					policies: Arr.reduce(synced, 0, (sum, outcome) => sum + outcome.policies),
					vulnerabilities: Arr.reduce(synced, 0, (sum, outcome) => sum + outcome.vulnerabilities),
				} satisfies FleetFindingsSyncResult
			}).pipe(Effect.withSpan("FleetFindingsService.syncDue"))

			const sources = Effect.fn("FleetFindingsService.sources")(function* (orgId: OrgId) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(FleetConnections)
							.select(
								"id",
								"organizationName",
								"baseUrl",
								"deviceCount",
								"findingsSyncedAt",
								"findingsError",
								"authFailedAt",
								"vulnerabilityCount",
							)
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)
				return Arr.map(rows, (row): DeviceSourceStatus => ({
					kind: "fleet",
					connectionId: row.id,
					label: row.organizationName,
					url: row.baseUrl,
					deviceCount: row.deviceCount,
					syncedAt: row.findingsSyncedAt,
					error: row.findingsError,
					authFailed: row.authFailedAt !== null,
					vulnerabilitiesUrl: `${row.baseUrl}/software/vulnerabilities`,
					reportedVulnerabilities: row.vulnerabilityCount,
				}))
			})

			return { syncDue, sources } satisfies FleetFindingsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
