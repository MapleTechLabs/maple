/**
 * The Security hub's Devices page: every connected device source's status, and their findings
 * merged into one list. A new source registers its status reader in `readers` (and its layer
 * below); its sync writes through `device-findings-store`.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { DevicePolicyFindings, DeviceVulnerabilityFindings } from "@maple/db/tables"
import {
	DevicePolicyFinding,
	DeviceSource,
	DevicesResponse,
	DeviceVulnerabilityFinding,
	IntegrationsPersistenceError,
	type OrgId,
} from "@maple/domain/http"
import { Array as Arr, Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { FleetFindingsService } from "@maple/backend/services/integrations/FleetFindingsService"
import {
	type DeviceSourceStatus,
	type DeviceSourceStatusReader,
	policyOrder,
	vulnerabilityOrder,
} from "./device-findings-store"

/** CVEs listed per source: one with scores never pushes an unscored one off the page. */
const LISTED_VULNERABILITIES = 500

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Device findings persistence failure",
)

export interface DeviceSecurityServiceApi {
	readonly devices: (orgId: OrgId) => Effect.Effect<DevicesResponse, IntegrationsPersistenceError>
}

export class DeviceSecurityService extends Context.Service<DeviceSecurityService, DeviceSecurityServiceApi>()(
	"@maple/backend/services/device-security/DeviceSecurityService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const fleet = yield* FleetFindingsService
			const dbExecute = makeDbExecute(database, "DeviceSecurityService", toPersistenceError)
			// Every device source, in the order the page lists them.
			const readers: ReadonlyArray<DeviceSourceStatusReader> = [fleet]

			const scopeOf =
				(orgId: OrgId, source: DeviceSourceStatus) =>
				($: PG.ColumnAccessor<typeof DeviceVulnerabilityFindings.columns>) => [
					$.orgId.eq(orgId),
					$.source.eq(source.kind),
					$.connectionId.eq(source.connectionId),
				]

			/**
			 * A connection's top CVEs and how many more it has, capped in the query: scored ones by
			 * score first, then unscored ones by devices, since SQL orders nulls first when descending.
			 */
			const listedFor = (orgId: OrgId, source: DeviceSourceStatus) =>
				Effect.all(
					[
						dbExecute((db) =>
							db.run(
								PG.from(DeviceVulnerabilityFindings)
									.select()
									.where(($) => [...scopeOf(orgId, source)($), $.cvssScore.isNotNull()])
									.orderBy(["cvssScore", "desc"], ["deviceCount", "desc"], ["cve", "asc"])
									.limit(LISTED_VULNERABILITIES),
							),
						),
						dbExecute((db) =>
							db.run(
								PG.from(DeviceVulnerabilityFindings)
									.select()
									.where(($) => [...scopeOf(orgId, source)($), $.cvssScore.isNull()])
									.orderBy(["deviceCount", "desc"], ["cve", "asc"])
									.limit(LISTED_VULNERABILITIES),
							),
						),
						dbExecute((db) =>
							db.run(
								PG.from(DeviceVulnerabilityFindings)
									.select(($) => ({
										count: PG.count(),
										knownExploited: PG.countIf($.knownExploited.eq(true)),
									}))
									.where(scopeOf(orgId, source)),
							),
						),
					],
					{ concurrency: 3 },
				).pipe(
					Effect.map(([scored, unscored, counted]) => ({
						source,
						rows: Arr.take(Arr.appendAll(scored, unscored), LISTED_VULNERABILITIES),
						// The source's own total when it gives one: it reads past what it stores.
						more: Math.max(
							0,
							Math.max(Number(counted[0]?.count ?? 0), source.reportedVulnerabilities ?? 0) -
								LISTED_VULNERABILITIES,
						),
						knownExploited: Number(counted[0]?.knownExploited ?? 0),
					})),
				)

			const devices = Effect.fn("DeviceSecurityService.devices")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const perReader = yield* Effect.forEach(readers, (reader) => reader.sources(orgId), {
					concurrency: "unbounded",
				})
				const sources = Arr.flatten(perReader)
				yield* Effect.annotateCurrentSpan("maple.device_security.sources", sources.length)
				if (sources.length === 0)
					return new DevicesResponse({
						sources: [],
						policies: [],
						vulnerabilities: [],
						moreVulnerabilities: 0,
					})
				// The policies and each source's CVEs are independent reads: run them together.
				const [policies, perSource] = yield* Effect.all(
					[
						dbExecute((db) =>
							db.run(
								PG.from(DevicePolicyFindings)
									.select()
									.where(($) => [$.orgId.eq(orgId)]),
							),
						),
						Effect.forEach(sources, (source) => listedFor(orgId, source), { concurrency: 2 }),
					],
					{ concurrency: 2 },
				)
				// Only what a connected source reported: rows outliving their connection never show.
				const connected = new Set(
					Arr.map(sources, (source) => `${source.kind}:${source.connectionId}`),
				)
				const isConnected = (row: { readonly source: string; readonly connectionId: string }) =>
					connected.has(`${row.source}:${row.connectionId}`)
				const listed = Arr.flatMap(perSource, ({ rows }) => rows)
				const withCounts = Arr.map(
					perSource,
					({ source: { reportedVulnerabilities: _reported, ...source }, more, knownExploited }) =>
						new DeviceSource({
							...source,
							moreVulnerabilities: more,
							knownExploitedVulnerabilities: knownExploited,
						}),
				)
				return new DevicesResponse({
					sources: withCounts,
					policies: Arr.map(
						Arr.sort(Arr.filter(policies, isConnected), policyOrder),
						(row) =>
							new DevicePolicyFinding({
								source: row.source,
								connectionId: row.connectionId,
								policyId: row.policyId,
								name: row.name,
								description: row.description,
								resolution: row.resolution,
								critical: row.critical,
								platform: row.platform,
								failingDeviceCount: row.failingDeviceCount,
								passingDeviceCount: row.passingDeviceCount,
								failingDevices: row.failingDevices,
								countedAt: row.countedAt,
								firstSeenAt: row.firstSeenAt,
								url: row.url,
							}),
					),
					vulnerabilities: Arr.map(
						Arr.sort(listed, vulnerabilityOrder),
						(row) =>
							new DeviceVulnerabilityFinding({
								source: row.source,
								connectionId: row.connectionId,
								cve: row.cve,
								cvssScore: row.cvssScore,
								epssProbability: row.epssProbability,
								knownExploited: row.knownExploited,
								detailsLink: row.detailsLink,
								deviceCount: row.deviceCount,
								software: row.software,
								firstSeenAt: row.firstSeenAt,
								url: row.url,
							}),
					),
					moreVulnerabilities: Arr.reduce(
						withCounts,
						0,
						(sum, source) => sum + source.moreVulnerabilities,
					),
				})
			})

			return { devices } satisfies DeviceSecurityServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FleetFindingsService.layer))
}
