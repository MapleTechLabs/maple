import type { DeviceRef } from "@maple/domain/device-security"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { timestampMs } from "@maple/backend/platform/time"
import {
	type PolicyFindingInput,
	policyOrder,
	type VulnerabilityFindingInput,
	vulnerabilityOrder,
} from "@maple/backend/services/device-security/device-findings-store"
import type { FleetHost, FleetPolicy, FleetSoftwareVersion } from "./api"

// Fleet's policies and vulnerable software as device findings: a failing policy per row, and one
// row per CVE with the software versions that carry it. Links go to the server's own pages.

/** A failing policy, with the numeric id its failing devices are read by. */
export interface FleetFailingPolicy {
	readonly fleetId: number
	readonly finding: Omit<PolicyFindingInput, "failingDevices">
}

/** The policies at least one device fails, critical first, then by how many fail. */
export const failingPolicies = (
	policies: ReadonlyArray<FleetPolicy>,
	baseUrl: string,
): ReadonlyArray<FleetFailingPolicy> =>
	Arr.sort(
		Arr.getSomes(
			Arr.map(policies, (policy): Option.Option<FleetFailingPolicy> => {
				const failing = policy.failing_host_count ?? 0
				if (failing <= 0) return Option.none()
				const counted =
					policy.host_count_updated_at === undefined || policy.host_count_updated_at === null
						? null
						: timestampMs(policy.host_count_updated_at)
				return Option.some({
					fleetId: policy.id,
					finding: {
						policyId: String(policy.id),
						name: policy.name,
						description: emptyToNull(policy.description),
						resolution: emptyToNull(policy.resolution),
						critical: policy.critical === true,
						platform: emptyToNull(policy.platform),
						failingDeviceCount: failing,
						// Null when Fleet has not counted the passing devices yet.
						passingDeviceCount: policy.passing_host_count ?? null,
						countedAt: counted === null || Number.isNaN(counted) ? null : counted,
						url: `${baseUrl}/policies/${policy.id}`,
					},
				})
			}),
		),
		Order.mapInput(policyOrder, (policy: FleetFailingPolicy) => policy.finding),
	)

const emptyToNull = (value: string | null | undefined): string | null =>
	value === undefined || value === null || value === "" ? null : value

/** A link the Devices page renders: https only, since the server chooses it. */
const httpsOnly = (value: string | null | undefined): string | null => {
	const link = emptyToNull(value)
	return link !== null && URL.canParse(link) && new URL(link).protocol === "https:" ? link : null
}

export const findingDevice = (host: FleetHost, baseUrl: string): DeviceRef => ({
	id: String(host.id),
	name: emptyToNull(host.display_name) ?? emptyToNull(host.hostname) ?? `host ${host.id}`,
	platform: emptyToNull(host.platform),
	url: `${baseUrl}/hosts/${host.id}`,
})

const maxOf = (values: ReadonlyArray<number | null>): number | null => {
	const present = Arr.filter(values, (value): value is number => value !== null)
	return Arr.isReadonlyArrayNonEmpty(present) ? Arr.max(present, Order.Number) : null
}

/** One finding per CVE across the software versions that carry it, highest score first. */
export const vulnerabilitiesBySoftware = (
	versions: ReadonlyArray<FleetSoftwareVersion>,
	baseUrl: string,
): ReadonlyArray<VulnerabilityFindingInput> => {
	const hits = Arr.flatMap(versions, (version) =>
		Arr.map(version.vulnerabilities ?? [], (vulnerability) => ({ version, vulnerability })),
	)
	const byCve = Arr.groupBy(hits, (hit) => hit.vulnerability.cve)
	const findings = Arr.map(Rec.values(byCve), (group): VulnerabilityFindingInput => {
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
			detailsLink: httpsOnly(first.details_link),
			deviceCount: Arr.reduce(group, 0, (sum, hit) => sum + (hit.version.hosts_count ?? 0)),
			software: Arr.map(group, (hit) => ({
				name: hit.version.name,
				version: hit.version.version,
				packageSource: emptyToNull(hit.version.source),
				deviceCount: hit.version.hosts_count ?? 0,
				resolvedInVersion: emptyToNull(hit.vulnerability.resolved_in_version),
			})),
			url: `${baseUrl}/software/vulnerabilities/${encodeURIComponent(first.cve)}`,
		}
	})
	return Arr.sort(findings, vulnerabilityOrder)
}
