/**
 * The write side every device source shares: a sync replaces one connection's findings, and a
 * removed connection clears them. Both run on the caller's `db`, inside its transaction.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	type DevicePolicyFindingRow,
	DevicePolicyFindings,
	type DeviceVulnerabilityFindingRow,
	DeviceVulnerabilityFindings,
} from "@maple/db/tables"
import type { DeviceSourceKind } from "@maple/domain/device-security"
import type { DeviceSource, IntegrationsPersistenceError, OrgId } from "@maple/domain/http"
import { Array as Arr, Effect, Order } from "effect"

export interface DeviceFindingsScope {
	readonly orgId: OrgId
	readonly source: DeviceSourceKind
	readonly connectionId: string
}

type Kept = "orgId" | "source" | "connectionId" | "firstSeenAt" | "lastSeenAt"
export type PolicyFindingInput = Omit<DevicePolicyFindingRow, Kept>
export type VulnerabilityFindingInput = Omit<DeviceVulnerabilityFindingRow, Kept>

export interface DeviceFindingsSnapshot {
	readonly policies: ReadonlyArray<PolicyFindingInput>
	readonly vulnerabilities: ReadonlyArray<VulnerabilityFindingInput>
	/**
	 * False when the source had more than it read: a CVE it did not reach is not resolved, so the
	 * ones stored before stay, for a day at most.
	 */
	readonly vulnerabilitiesComplete: boolean
}

/** How long a partial read keeps a CVE it did not reach before taking it as gone. */
const UNREACHED_KEPT_MS = 24 * 60 * 60_000

/** Rows per INSERT: Postgres binds at most 65535 values a statement, and effect-orm never splits. */
const ROWS_PER_INSERT = 1_000

type PolicyRank = { readonly critical: boolean; readonly failingDeviceCount: number }
type VulnerabilityRank = { readonly cvssScore: number | null; readonly deviceCount: number }

/** Critical first, then by how many devices fail. */
export const policyOrder: Order.Order<PolicyRank> = Order.combine(
	Order.mapInput(Order.Boolean, (finding: PolicyRank) => !finding.critical),
	Order.mapInput(Order.flip(Order.Number), (finding: PolicyRank) => finding.failingDeviceCount),
)

/** Highest score first (unscored last), then by devices. */
export const vulnerabilityOrder: Order.Order<VulnerabilityRank> = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (finding: VulnerabilityRank) => finding.cvssScore ?? -1),
	Order.mapInput(Order.flip(Order.Number), (finding: VulnerabilityRank) => finding.deviceCount),
)

/**
 * Makes the connection's findings what the source reports now. A finding still open keeps the
 * time it was first seen; one the source no longer reports is resolved and goes.
 */
export const replaceDeviceFindings = (
	db: MapleDb,
	scope: DeviceFindingsScope,
	now: number,
	snapshot: DeviceFindingsSnapshot,
) =>
	Effect.gen(function* () {
		const seen = { ...scope, firstSeenAt: now, lastSeenAt: now }
		yield* Effect.forEach(Arr.chunksOf(snapshot.policies, ROWS_PER_INSERT), (policies) =>
			db.run(
				PG.insertInto(DevicePolicyFindings)
					.values(Arr.map(policies, (policy) => ({ ...policy, ...seen })))
					.onConflictDoUpdate({
						target: ["orgId", "source", "connectionId", "policyId"],
						set: (_, excluded) => ({
							name: excluded.name,
							groupName: excluded.groupName,
							description: excluded.description,
							resolution: excluded.resolution,
							critical: excluded.critical,
							platform: excluded.platform,
							failingDeviceCount: excluded.failingDeviceCount,
							passingDeviceCount: excluded.passingDeviceCount,
							failingDevices: excluded.failingDevices,
							countedAt: excluded.countedAt,
							url: excluded.url,
							lastSeenAt: excluded.lastSeenAt,
						}),
					}),
			),
		)
		yield* Effect.forEach(Arr.chunksOf(snapshot.vulnerabilities, ROWS_PER_INSERT), (vulnerabilities) =>
			db.run(
				PG.insertInto(DeviceVulnerabilityFindings)
					.values(Arr.map(vulnerabilities, (finding) => ({ ...finding, ...seen })))
					.onConflictDoUpdate({
						target: ["orgId", "source", "connectionId", "cve"],
						set: (_, excluded) => ({
							cvssScore: excluded.cvssScore,
							epssProbability: excluded.epssProbability,
							knownExploited: excluded.knownExploited,
							detailsLink: excluded.detailsLink,
							deviceCount: excluded.deviceCount,
							software: excluded.software,
							url: excluded.url,
							lastSeenAt: excluded.lastSeenAt,
						}),
					}),
			),
		)
		yield* db.run(
			PG.deleteFrom(DevicePolicyFindings).where(($) => [
				$.orgId.eq(scope.orgId),
				$.source.eq(scope.source),
				$.connectionId.eq(scope.connectionId),
				$.lastSeenAt.lt(now),
			]),
		)
		yield* db.run(
			PG.deleteFrom(DeviceVulnerabilityFindings).where(($) => [
				$.orgId.eq(scope.orgId),
				$.source.eq(scope.source),
				$.connectionId.eq(scope.connectionId),
				$.lastSeenAt.lt(snapshot.vulnerabilitiesComplete ? now : now - UNREACHED_KEPT_MS),
			]),
		)
	})

/**
 * Forgets what a connection reported: it was removed or replaced. Run it after deleting the
 * connection row, so a sync holding that row has committed and its rows are seen.
 */
export const clearDeviceFindings = (db: MapleDb, scope: DeviceFindingsScope) =>
	Effect.gen(function* () {
		yield* db.run(
			PG.deleteFrom(DevicePolicyFindings).where(($) => [
				$.orgId.eq(scope.orgId),
				$.source.eq(scope.source),
				$.connectionId.eq(scope.connectionId),
			]),
		)
		yield* db.run(
			PG.deleteFrom(DeviceVulnerabilityFindings).where(($) => [
				$.orgId.eq(scope.orgId),
				$.source.eq(scope.source),
				$.connectionId.eq(scope.connectionId),
			]),
		)
	})

/** A connection as its source reports it; the read service adds what it counts from the findings. */
export type DeviceSourceStatus = Omit<
	DeviceSource,
	"moreVulnerabilities" | "knownExploitedVulnerabilities"
> & {
	/** Every CVE the source counts, past those it stored; null when it gives no total. */
	readonly reportedVulnerabilities: number | null
}

/** What a device source tells the Devices page about the org's connections to it. */
export interface DeviceSourceStatusReader {
	readonly sources: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<DeviceSourceStatus>, IntegrationsPersistenceError>
}
