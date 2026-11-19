import type { FleetFindingHost, FleetVulnerableSoftware } from "@maple/db/tables"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { timestampMs } from "@maple/backend/platform/time"
import type { FleetHost, FleetPolicy, FleetSoftwareVersion } from "./api"

// Fleet's policies and vulnerable software as Security Center findings: a failing policy per row,
// and one row per CVE with the software versions that carry it.

type PolicyRank = { readonly critical: boolean; readonly failingHostCount: number }
type VulnerabilityRank = { readonly cvssScore: number | null; readonly hostCount: number }

/** Critical first, then by how many devices fail. */
export const policyOrder: Order.Order<PolicyRank> = Order.combine(
	Order.mapInput(Order.Boolean, (finding: PolicyRank) => !finding.critical),
	Order.mapInput(Order.flip(Order.Number), (finding: PolicyRank) => finding.failingHostCount),
)

/** Highest score first (unscored last), then by devices. */
export const vulnerabilityOrder: Order.Order<{
	readonly cvssScore: number | null
	readonly hostCount: number
}> = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (finding: VulnerabilityRank) => finding.cvssScore ?? -1),
	Order.mapInput(Order.flip(Order.Number), (finding: VulnerabilityRank) => finding.hostCount),
)

export interface PolicyFinding {
	readonly policyId: number
	readonly name: string
	readonly description: string | null
	readonly resolution: string | null
	readonly critical: boolean
	readonly platform: string | null
	readonly failingHostCount: number
	readonly passingHostCount: number
	readonly countedAt: number | null
}

/** The policies at least one device fails, critical first, then by how many fail. */
export const failingPolicies = (policies: ReadonlyArray<FleetPolicy>): ReadonlyArray<PolicyFinding> =>
	Arr.sort(
		Arr.getSomes(
			Arr.map(policies, (policy): Option.Option<PolicyFinding> => {
				const failing = policy.failing_host_count ?? 0
				if (failing <= 0) return Option.none()
				const counted =
					policy.host_count_updated_at === undefined || policy.host_count_updated_at === null
						? null
						: timestampMs(policy.host_count_updated_at)
				return Option.some({
					policyId: policy.id,
					name: policy.name,
					description: emptyToNull(policy.description),
					resolution: emptyToNull(policy.resolution),
					critical: policy.critical === true,
					platform: emptyToNull(policy.platform),
					failingHostCount: failing,
					passingHostCount: policy.passing_host_count ?? 0,
					countedAt: counted === null || Number.isNaN(counted) ? null : counted,
				})
			}),
		),
		policyOrder,
	)

const emptyToNull = (value: string | null | undefined): string | null =>
	value === undefined || value === null || value === "" ? null : value

export const findingHost = (host: FleetHost): FleetFindingHost => ({
	id: host.id,
	name: emptyToNull(host.display_name) ?? emptyToNull(host.hostname) ?? `host ${host.id}`,
	platform: emptyToNull(host.platform),
})

export interface VulnerabilityFinding {
	readonly cve: string
	readonly cvssScore: number | null
	readonly epssProbability: number | null
	readonly knownExploited: boolean | null
	readonly detailsLink: string | null
	readonly hostCount: number
	readonly software: ReadonlyArray<FleetVulnerableSoftware>
}

const maxOf = (values: ReadonlyArray<number | null>): number | null => {
	const present = Arr.filter(values, (value): value is number => value !== null)
	return Arr.isReadonlyArrayNonEmpty(present) ? Arr.max(present, Order.Number) : null
}

/** One finding per CVE across the software versions that carry it, highest score first. */
export const vulnerabilitiesBySoftware = (
	versions: ReadonlyArray<FleetSoftwareVersion>,
): ReadonlyArray<VulnerabilityFinding> => {
	const hits = Arr.flatMap(versions, (version) =>
		Arr.map(version.vulnerabilities ?? [], (vulnerability) => ({ version, vulnerability })),
	)
	const byCve = Arr.groupBy(hits, (hit) => hit.vulnerability.cve)
	const findings = Arr.map(Rec.values(byCve), (group): VulnerabilityFinding => {
		const first = Arr.headNonEmpty(group).vulnerability
		const scores = Arr.map(group, (hit) => hit.vulnerability.cvss_score ?? null)
		const exploited = Arr.map(group, (hit) => hit.vulnerability.cisa_known_exploit ?? null)
		return {
			cve: first.cve,
			cvssScore: maxOf(scores),
			epssProbability: maxOf(Arr.map(group, (hit) => hit.vulnerability.epss_probability ?? null)),
			knownExploited: Arr.some(exploited, (value) => value === true)
				? true
				: Arr.some(exploited, (value) => value === false)
					? false
					: null,
			detailsLink: emptyToNull(first.details_link),
			hostCount: Arr.reduce(group, 0, (sum, hit) => sum + (hit.version.hosts_count ?? 0)),
			software: Arr.map(group, (hit) => ({
				name: hit.version.name,
				version: hit.version.version,
				source: emptyToNull(hit.version.source),
				hostCount: hit.version.hosts_count ?? 0,
				resolvedInVersion: emptyToNull(hit.vulnerability.resolved_in_version),
			})),
		}
	})
	return Arr.sort(findings, vulnerabilityOrder)
}
