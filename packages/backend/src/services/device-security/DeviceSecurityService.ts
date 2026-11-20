/**
 * The Security hub's Devices page: every connected device source's status, and their findings
 * merged into one list. A new source registers its status reader below; its sync writes through
 * `device-findings-store`.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { DevicePolicyFindings, DeviceVulnerabilityFindings } from "@maple/db/tables"
import {
	DevicePolicyFinding,
	type DeviceSource,
	DevicesResponse,
	DeviceVulnerabilityFinding,
	IntegrationsPersistenceError,
	type OrgId,
} from "@maple/domain/http"
import { Array as Arr, Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { FleetFindingsService } from "@maple/backend/services/integrations/FleetFindingsService"
import { policyOrder, vulnerabilityOrder } from "./device-findings-store"

const LISTED_VULNERABILITIES = 500

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Device findings persistence failure",
)

/** What a device source tells the page about its connections. */
export interface DeviceSourceStatusReader {
	readonly sources: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<DeviceSource>, IntegrationsPersistenceError>
}

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

			const devices = Effect.fn("DeviceSecurityService.devices")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const perReader = yield* Effect.forEach(readers, (reader) => reader.sources(orgId), {
					concurrency: "unbounded",
				})
				const sources = Arr.flatten(perReader)
				yield* Effect.annotateCurrentSpan("maple.device_security.sources", sources.length)
				if (sources.length === 0)
					return new DevicesResponse({
						sources,
						policies: [],
						vulnerabilities: [],
						moreVulnerabilities: 0,
					})
				const [policies, vulnerabilities] = yield* Effect.all(
					[
						dbExecute((db) =>
							db.run(
								PG.from(DevicePolicyFindings)
									.select()
									.where(($) => [$.orgId.eq(orgId)]),
							),
						),
						dbExecute((db) =>
							db.run(
								PG.from(DeviceVulnerabilityFindings)
									.select()
									.where(($) => [$.orgId.eq(orgId)]),
							),
						),
					],
					{ concurrency: 2 },
				)
				// Only what a connected source reported: rows outliving their connection never show.
				const connected = new Set(
					Arr.map(sources, (source) => `${source.kind}:${source.connectionId}`),
				)
				const isConnected = (row: { readonly source: string; readonly connectionId: string }) =>
					connected.has(`${row.source}:${row.connectionId}`)
				const openVulnerabilities = Arr.filter(vulnerabilities, isConnected)
				return new DevicesResponse({
					sources,
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
						Arr.take(Arr.sort(openVulnerabilities, vulnerabilityOrder), LISTED_VULNERABILITIES),
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
					moreVulnerabilities: Math.max(0, openVulnerabilities.length - LISTED_VULNERABILITIES),
				})
			})

			return { devices } satisfies DeviceSecurityServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FleetFindingsService.layer))
}
