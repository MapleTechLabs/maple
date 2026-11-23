import type { DeviceRef } from "@maple/domain/device-security"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { timestampMs } from "@maple/backend/platform/time"
import {
	type PolicyFindingInput,
	policyOrder,
	type VulnerabilityFindingInput,
	vulnerabilityOrder,
} from "@maple/backend/services/device-security/device-findings-store"
import type { FleetCve, FleetHost, FleetPolicy, FleetSoftwareVersion, FleetVulnerability } from "./api"

// Fleet's policies and vulnerable software as device findings: a failing policy per row, whichever
// fleet it belongs to, and one row per CVE with the software versions that carry it. Links go to the server's own pages.

/** A policy with the fleet it belongs to; null for a policy every device gets. */
export interface FleetScopedPolicy {
	readonly policy: FleetPolicy
	readonly groupName: string | null
}

/** A failing policy, with the numeric id its failing devices are read by. */
export interface FleetFailingPolicy {
	readonly fleetId: number
	readonly finding: Omit<PolicyFindingInput, "failingDevices">
}

/** The policies at least one device fails, critical first, then by how many fail. */
export const failingPolicies = (
	policies: ReadonlyArray<FleetScopedPolicy>,
	baseUrl: string,
): ReadonlyArray<FleetFailingPolicy> =>
	Arr.sort(
		Arr.getSomes(
			Arr.map(policies, ({ policy, groupName }): Option.Option<FleetFailingPolicy> => {
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
						groupName,
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

type Hit = { readonly version: FleetSoftwareVersion; readonly vulnerability: FleetVulnerability }

/** Each CVE's hits: the software versions that carry it, with what they say about it. */
const hitsByCve = (versions: ReadonlyArray<FleetSoftwareVersion>) =>
	Arr.groupBy(
		Arr.flatMap(versions, (version) =>
			Arr.map(version.vulnerabilities ?? [], (vulnerability): Hit => ({ version, vulnerability })),
		),
		(hit) => hit.vulnerability.cve,
	)

const anyOf = (values: ReadonlyArray<boolean | null>): boolean | null =>
	Arr.some(values, (value) => value === true)
		? true
		: Arr.some(values, (value) => value === false)
			? false
			: null

/**
 * A CVE's finding from the software that carries it. `counted` is Fleet's own row for the CVE:
 * its device count (a device with two affected packages counts once) and scores win.
 */
const findingOf = (
	cve: string,
	hits: ReadonlyArray<Hit>,
	baseUrl: string,
	counted?: FleetCve,
): VulnerabilityFindingInput => {
	const said = <A>(read: (vulnerability: FleetVulnerability) => A | null | undefined) =>
		Arr.map(hits, (hit) => read(hit.vulnerability) ?? null)
	return {
		cve,
		cvssScore: counted?.cvss_score ?? maxOf(said((vulnerability) => vulnerability.cvss_score)),
		epssProbability:
			counted?.epss_probability ?? maxOf(said((vulnerability) => vulnerability.epss_probability)),
		knownExploited:
			counted?.cisa_known_exploit ?? anyOf(said((vulnerability) => vulnerability.cisa_known_exploit)),
		detailsLink: httpsOnly(
			counted?.details_link ??
				Arr.findFirst(
					said((vulnerability) => vulnerability.details_link),
					(link) => link !== null,
				).pipe(Option.getOrNull),
		),
		deviceCount:
			counted?.hosts_count ?? Arr.reduce(hits, 0, (sum, hit) => sum + (hit.version.hosts_count ?? 0)),
		software: Arr.map(hits, (hit) => ({
			name: hit.version.name,
			version: hit.version.version,
			packageSource: emptyToNull(hit.version.source),
			deviceCount: hit.version.hosts_count ?? 0,
			resolvedInVersion: emptyToNull(hit.vulnerability.resolved_in_version),
		})),
		url: `${baseUrl}/software/vulnerabilities/${encodeURIComponent(cve)}`,
	}
}

/**
 * One finding per CVE from software versions alone, for a server without `/vulnerabilities`: the
 * device count sums the versions, so a device with two affected packages counts twice.
 */
export const vulnerabilitiesBySoftware = (
	versions: ReadonlyArray<FleetSoftwareVersion>,
	baseUrl: string,
): ReadonlyArray<VulnerabilityFindingInput> =>
	Arr.sort(
		Arr.map(Rec.toEntries(hitsByCve(versions)), ([cve, hits]) => findingOf(cve, hits, baseUrl)),
		vulnerabilityOrder,
	)

/** One finding per CVE Fleet counted, with the software read for it where that read reached it. */
export const vulnerabilitiesByCve = (
	cves: ReadonlyArray<FleetCve>,
	versions: ReadonlyArray<FleetSoftwareVersion>,
	baseUrl: string,
): ReadonlyArray<VulnerabilityFindingInput> => {
	const byCve = hitsByCve(versions)
	return Arr.sort(
		Arr.map(
			Arr.dedupeWith(cves, (a, b) => a.cve === b.cve),
			(counted) => findingOf(counted.cve, byCve[counted.cve] ?? [], baseUrl, counted),
		),
		vulnerabilityOrder,
	)
}
