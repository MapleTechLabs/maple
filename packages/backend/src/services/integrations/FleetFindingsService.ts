/**
 * The Security hub's Devices page: each Fleet server's failing policies and vulnerable software,
 * synced hourly under the connection's findings lease. A sync replaces the server's findings: a
 * policy every device passes again, or a CVE no longer installed, drops out.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	type FleetConnectionRow,
	FleetConnections,
	type FleetFindingHost,
	FleetPolicyFindings,
	FleetVulnerabilityFindings,
} from "@maple/db/tables"
import {
	FleetDevicesConnection,
	FleetDevicesResponse,
	FleetPolicyFinding,
	FleetVulnerabilityFinding,
	IntegrationsPersistenceError,
	type OrgId,
} from "@maple/domain/http"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { openSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { fleetTokenSlot } from "@maple/backend/platform/secret-slots"
import { leaseStillOurs } from "./lease"
import { type Lease, type LeaseSpec, leaseFree, withLease } from "./poller"
import * as FleetApi from "./fleet/api"
import {
	failingPolicies,
	findingHost,
	policyOrder,
	type PolicyFinding,
	vulnerabilitiesBySoftware,
	vulnerabilityOrder,
} from "./fleet/findings"

const SYNC_EVERY_MS = 60 * 60_000
const LEASE_MS = 4 * 60_000
/** After this long in a lane, no new server starts: the lane ends at 270 seconds. */
const START_BY_MS = 150_000
/** Failing devices kept per policy, and policies sampled per sync. */
const HOSTS_PER_POLICY = 20
const SAMPLED_POLICIES = 100
const SOFTWARE_PAGE_SIZE = 100
const MAX_SOFTWARE_PAGES = 10
const LISTED_VULNERABILITIES = 500

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

export interface FleetFindingsServiceApi {
	/** Syncs every server whose findings are an hour old, or never synced. */
	readonly syncDue: Effect.Effect<FleetFindingsSyncResult, IntegrationsPersistenceError>
	readonly devices: (orgId: OrgId) => Effect.Effect<FleetDevicesResponse, IntegrationsPersistenceError>
}

const hostUrl = (baseUrl: string, id: number) => `${baseUrl}/hosts/${id}`

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

			const readSoftware = (
				fleet: FleetApi.FleetClient,
				page: number,
				acc: ReadonlyArray<FleetApi.FleetSoftwareVersion>,
			): Effect.Effect<ReadonlyArray<FleetApi.FleetSoftwareVersion>, FleetApi.FleetApiError> =>
				FleetApi.listVulnerableSoftware(fleet, page, SOFTWARE_PAGE_SIZE).pipe(
					Effect.flatMap((answer) => {
						const all = Arr.appendAll(acc, answer.software ?? [])
						return answer.meta?.has_next_results === true && page + 1 < MAX_SOFTWARE_PAGES
							? readSoftware(fleet, page + 1, all)
							: Effect.succeed(all)
					}),
				)

			/** What the server reports now: counts, failing policies with sample devices, CVEs. */
			const read = Effect.fnUntraced(function* (fleet: FleetApi.FleetClient) {
				const [hosts, policies] = yield* Effect.all(
					[FleetApi.countHosts(fleet), FleetApi.listGlobalPolicies(fleet)],
					{ concurrency: 2 },
				)
				const failing = failingPolicies(policies.policies ?? [])
				const samples = yield* Effect.forEach(
					Arr.take(failing, SAMPLED_POLICIES),
					(policy) =>
						FleetApi.listFailingHosts(fleet, policy.policyId, HOSTS_PER_POLICY).pipe(
							Effect.map(
								(page) => [policy.policyId, Arr.map(page.hosts ?? [], findingHost)] as const,
							),
						),
					{ concurrency: 2 },
				)
				const software = yield* readSoftware(fleet, 0, [])
				return {
					hostCount: hosts.count,
					policies: failing,
					sampledHosts: new Map<number, ReadonlyArray<FleetFindingHost>>(samples),
					vulnerabilities: vulnerabilitiesBySoftware(software),
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
			) => {
				const scope = { orgId: claimed.orgId, connectionId: claimed.id }
				const policyRow = (policy: PolicyFinding) => ({
					...scope,
					...policy,
					failingHosts: snapshot.sampledHosts.get(policy.policyId) ?? [],
					firstSeenAt: now,
					lastSeenAt: now,
				})
				return dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const owned = yield* db.run(
								PG.update(FleetConnections)
									.set({
										findingsSyncedAt: now,
										findingsError: null,
										findingsErrorAt: null,
										hostCount: snapshot.hostCount,
									})
									.where(stillOurs(claimed))
									.returning("id"),
							)
							if (owned.length === 0) return false
							if (snapshot.policies.length > 0)
								yield* db.run(
									PG.insertInto(FleetPolicyFindings)
										.values(Arr.map(snapshot.policies, policyRow))
										.onConflictDoUpdate({
											target: ["orgId", "connectionId", "policyId"],
											set: (_, excluded) => ({
												name: excluded.name,
												description: excluded.description,
												resolution: excluded.resolution,
												critical: excluded.critical,
												platform: excluded.platform,
												failingHostCount: excluded.failingHostCount,
												passingHostCount: excluded.passingHostCount,
												failingHosts: excluded.failingHosts,
												countedAt: excluded.countedAt,
												lastSeenAt: excluded.lastSeenAt,
											}),
										}),
								)
							if (snapshot.vulnerabilities.length > 0)
								yield* db.run(
									PG.insertInto(FleetVulnerabilityFindings)
										.values(
											Arr.map(snapshot.vulnerabilities, (finding) => ({
												...scope,
												...finding,
												firstSeenAt: now,
												lastSeenAt: now,
											})),
										)
										.onConflictDoUpdate({
											target: ["orgId", "connectionId", "cve"],
											set: (_, excluded) => ({
												cvssScore: excluded.cvssScore,
												epssProbability: excluded.epssProbability,
												knownExploited: excluded.knownExploited,
												detailsLink: excluded.detailsLink,
												hostCount: excluded.hostCount,
												software: excluded.software,
												lastSeenAt: excluded.lastSeenAt,
											}),
										}),
								)
							// What this sync did not see is resolved.
							yield* db.run(
								PG.deleteFrom(FleetPolicyFindings).where(($) => [
									$.orgId.eq(claimed.orgId),
									$.connectionId.eq(claimed.id),
									$.lastSeenAt.lt(now),
								]),
							)
							yield* db.run(
								PG.deleteFrom(FleetVulnerabilityFindings).where(($) => [
									$.orgId.eq(claimed.orgId),
									$.connectionId.eq(claimed.id),
									$.lastSeenAt.lt(now),
								]),
							)
							return true
						}),
					),
				)
			}

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
					}).pipe(Effect.flatMap(read)),
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
							return yield* fail(failure.message)
					}
				}
				const stored = yield* Effect.result(store(claimed, now, snapshot.success))
				if (stored._tag === "Failure")
					return yield* fail(
						"Findings were read from Fleet but could not be saved. Maple retries next tick.",
					)
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

			const devices = Effect.fn("FleetFindingsService.devices")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const connections = yield* dbExecute((db) =>
					db.run(
						PG.from(FleetConnections)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				)
				const connection = connections[0]
				if (connection === undefined)
					return new FleetDevicesResponse({
						connection: null,
						policies: [],
						vulnerabilities: [],
						moreVulnerabilities: 0,
					})
				const [policies, vulnerabilities] = yield* Effect.all(
					[
						dbExecute((db) =>
							db.run(
								PG.from(FleetPolicyFindings)
									.select()
									.where(($) => [$.orgId.eq(orgId), $.connectionId.eq(connection.id)]),
							),
						),
						dbExecute((db) =>
							db.run(
								PG.from(FleetVulnerabilityFindings)
									.select()
									.where(($) => [$.orgId.eq(orgId), $.connectionId.eq(connection.id)]),
							),
						),
					],
					{ concurrency: 2 },
				)
				const base = connection.baseUrl
				return new FleetDevicesResponse({
					connection: new FleetDevicesConnection({
						organizationName: connection.organizationName,
						baseUrl: base,
						licenseTier: connection.licenseTier,
						hostCount: connection.hostCount,
						syncedAt: connection.findingsSyncedAt,
						error: connection.findingsError,
						authFailed: connection.authFailedAt !== null,
					}),
					policies: Arr.map(
						Arr.sort(policies, policyOrder),
						(row) =>
							new FleetPolicyFinding({
								policyId: row.policyId,
								name: row.name,
								description: row.description,
								resolution: row.resolution,
								critical: row.critical,
								platform: row.platform,
								failingHostCount: row.failingHostCount,
								passingHostCount: row.passingHostCount,
								failingHosts: Arr.map(row.failingHosts, (host) => ({
									...host,
									url: hostUrl(base, host.id),
								})),
								countedAt: row.countedAt,
								firstSeenAt: row.firstSeenAt,
								url: `${base}/policies/${row.policyId}`,
							}),
					),
					vulnerabilities: Arr.map(
						Arr.take(Arr.sort(vulnerabilities, vulnerabilityOrder), LISTED_VULNERABILITIES),
						(row) =>
							new FleetVulnerabilityFinding({
								cve: row.cve,
								cvssScore: row.cvssScore,
								epssProbability: row.epssProbability,
								knownExploited: row.knownExploited,
								detailsLink: row.detailsLink,
								hostCount: row.hostCount,
								software: row.software,
								firstSeenAt: row.firstSeenAt,
								url: `${base}/software/vulnerabilities/${encodeURIComponent(row.cve)}`,
							}),
					),
					moreVulnerabilities: Math.max(0, vulnerabilities.length - LISTED_VULNERABILITIES),
				})
			})

			return { syncDue, devices } satisfies FleetFindingsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
