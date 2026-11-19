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
import { leaseFree } from "./poller"
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
const RATE_LIMIT_HOLD_MS = 15 * 60_000
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

			/** The row, once this tick holds its findings lease; null when another tick or a hold has it. */
			const claim = (connectionId: string, now: number) =>
				dbExecute((db) =>
					db.run(
						PG.update(FleetConnections)
							.set({ findingsLeaseUntil: now + LEASE_MS })
							.where(($) => [
								$.id.eq(connectionId),
								$.authFailedAt.isNull(),
								leaseFree($.findingsLeaseUntil, $.findingsHoldUntil, now, LEASE_MS),
							])
							.returning(),
					),
				).pipe(Effect.map((rows) => rows[0] ?? null))

			/** One write on the claimed row; false once a reconnect or a later tick owns it. */
			const writeClaimed = (
				claimed: FleetConnectionRow,
				set: PG.UpdateSetOf<typeof FleetConnections>,
			) =>
				dbExecute((db) =>
					db.run(
						PG.update(FleetConnections)
							.set(set)
							.where(($) => [
								$.id.eq(claimed.id),
								leaseStillOurs($.findingsLeaseUntil, claimed.findingsLeaseUntil),
								$.tokenCiphertext.eq(claimed.tokenCiphertext),
							])
							.returning("id"),
					),
				).pipe(Effect.map((rows) => rows.length > 0))

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
					{ concurrency: 4 },
				)
				const pages = yield* readSoftware(fleet, 0, [])
				return {
					hostCount: hosts.count,
					policies: failing,
					sampledHosts: new Map<number, ReadonlyArray<FleetFindingHost>>(samples),
					vulnerabilities: vulnerabilitiesBySoftware(pages),
				}
			})

			const readSoftware = (
				fleet: FleetApi.FleetClient,
				page: number,
				read: ReadonlyArray<FleetApi.FleetSoftwareVersion>,
			): Effect.Effect<ReadonlyArray<FleetApi.FleetSoftwareVersion>, FleetApi.FleetApiError> =>
				FleetApi.listVulnerableSoftware(fleet, page, SOFTWARE_PAGE_SIZE).pipe(
					Effect.flatMap((answer) => {
						const all = Arr.appendAll(read, answer.software ?? [])
						return answer.meta?.has_next_results === true && page + 1 < MAX_SOFTWARE_PAGES
							? readSoftware(fleet, page + 1, all)
							: Effect.succeed(all)
					}),
				)

			/** Replaces the server's findings with what it reports now, in one transaction. */
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
						}),
					),
				)
			}

			const syncClaimed = Effect.fn("FleetFindingsService.syncServer")(function* (
				claimed: FleetConnectionRow,
				now: number,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: claimed.orgId,
					"maple.fleet.connection_id": claimed.id,
				})
				const fail = (message: string, hold: number | null = null) =>
					writeClaimed(claimed, {
						findingsLeaseUntil: null,
						findingsHoldUntil: hold,
						findingsError: message,
						findingsErrorAt: now,
					}).pipe(Effect.as({ failed: true, policies: 0, vulnerabilities: 0 }))

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
					if (failure.kind === "unauthorized")
						return yield* writeClaimed(claimed, {
							findingsLeaseUntil: null,
							authFailedAt: now,
							lastError: failure.message,
							lastErrorAt: now,
							findingsError: failure.message,
							findingsErrorAt: now,
						}).pipe(Effect.as({ failed: true, policies: 0, vulnerabilities: 0 }))
					return yield* fail(
						failure.message,
						failure.kind === "rate_limited"
							? now + Math.max(RATE_LIMIT_HOLD_MS, (failure.retryAfterSeconds ?? 0) * 1000)
							: null,
					)
				}
				yield* store(claimed, now, snapshot.success)
				yield* Effect.annotateCurrentSpan({
					"maple.fleet.policies": snapshot.success.policies.length,
					"maple.fleet.vulnerabilities": snapshot.success.vulnerabilities.length,
				})
				yield* writeClaimed(claimed, {
					findingsLeaseUntil: null,
					findingsHoldUntil: null,
					findingsSyncedAt: now,
					findingsError: null,
					findingsErrorAt: null,
					hostCount: snapshot.success.hostCount,
				})
				return {
					failed: false,
					policies: snapshot.success.policies.length,
					vulnerabilities: snapshot.success.vulnerabilities.length,
				}
			})

			const syncDue = Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const due = yield* dbExecute((db) =>
					db.run(
						PG.from(FleetConnections)
							.select("id")
							.where(($) => [
								$.authFailedAt.isNull(),
								PG.or(
									$.findingsSyncedAt.isNull(),
									$.findingsSyncedAt.lte(now - SYNC_EVERY_MS),
								),
							]),
					),
				)
				const outcomes = yield* Effect.forEach(
					due,
					(candidate) =>
						claim(candidate.id, now).pipe(
							Effect.flatMap((claimed) =>
								claimed === null
									? Effect.succeedNone
									: Effect.asSome(syncClaimed(claimed, now)),
							),
							// One server's broken row never stops the others; its lease runs out on its own.
							Effect.catch((error) =>
								Effect.logWarning("Fleet findings sync failed").pipe(
									Effect.annotateLogs({ connectionId: candidate.id, error }),
									Effect.as(Option.some({ failed: true, policies: 0, vulnerabilities: 0 })),
								),
							),
						),
					{ concurrency: 4 },
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
