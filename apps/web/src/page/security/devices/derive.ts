import type { DeviceSourceKind, VulnerableSoftware } from "@maple/domain/device-security"
import type { DevicePolicyFinding, DeviceSource, DeviceVulnerabilityFinding } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Option, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import { osName } from "../../kit/platform-label"
import type { ProviderId } from "../../kit/providers"
import type { Devices, Model } from "./model"

// Pure readings of the Devices page: which state it is in, and the words each row shows.

/** What the page says about one kind of device source. Adding a source is one entry here. */
export type DeviceSourceBrand = Readonly<{
	name: string
	provider: ProviderId
	/** Where its credential is saved or replaced. */
	connectHref: string
	/** What the saved credential is called, as in "rejected the saved token". */
	credential: string
	/** Why its CVEs carry no CVSS score or known exploited flag, when they don't. */
	noScoresNote: string
	/** The all-clear for policies, saying which ones the source reads. */
	noFailingPolicies: string
}>

export const DEVICE_SOURCE_BRANDS = {
	fleet: {
		name: "Fleet",
		provider: "fleet",
		connectHref: hrefOf(AppRoute.Integrations({ search: { integration: "fleet" } })),
		credential: "token",
		noScoresNote: "CVSS scores and known exploited flags need Fleet Premium",
		noFailingPolicies:
			"Every enrolled device passes every policy on your Fleet server: the global ones, each fleet's and those for devices in no fleet.",
	},
} satisfies Readonly<Record<DeviceSourceKind, DeviceSourceBrand>>

export const brandOf = (kind: DeviceSourceKind): DeviceSourceBrand => DEVICE_SOURCE_BRANDS[kind]

export type Screen =
	| Readonly<{ _tag: "Loading" }>
	| Readonly<{ _tag: "Forbidden" }>
	| Readonly<{ _tag: "Failed"; failure: LoadFailure }>
	| Readonly<{ _tag: "NotConnected" }>
	| Readonly<{ _tag: "Connected"; devices: Devices }>

/** A viewer without `security:manage` gets the integrations 403. */
const isForbidden = (failure: LoadFailure): boolean => failure.code === "integration_forbidden"

export const screenOf = (model: Pick<Model, "devices">): Screen =>
	AsyncData.matchData(model.devices.data, {
		onEmpty: (): Screen => ({ _tag: "Loading" }),
		onFailure: (failure): Screen =>
			isForbidden(failure) ? { _tag: "Forbidden" } : { _tag: "Failed", failure },
		onData: (devices): Screen =>
			devices.sources.length === 0 ? { _tag: "NotConnected" } : { _tag: "Connected", devices },
	})

/** The account name the source reports, else its brand. */
export const sourceLabelOf = (source: DeviceSource): string => source.label ?? brandOf(source.kind).name

/** A policy's key in `expanded`: ids are only unique within one connection. */
export const policyKeyOf = (policy: DevicePolicyFinding): string =>
	`${policy.source}:${policy.connectionId}:${policy.policyId}`

/**
 * The tag a finding shows when more than one source is connected: the brand, or the account name
 * when the same kind is connected twice. Null with a single source.
 */
export const sourceTagOf = (
	sources: ReadonlyArray<DeviceSource>,
	finding: Readonly<{ source: DeviceSourceKind; connectionId: string }>,
): string | null => {
	if (sources.length < 2) return null
	const brand = brandOf(finding.source).name
	const sameKind = Arr.filter(sources, (source) => source.kind === finding.source)
	if (sameKind.length < 2) return brand
	return Option.match(
		Arr.findFirst(sameKind, (source) => source.connectionId === finding.connectionId),
		{ onNone: () => brand, onSome: sourceLabelOf },
	)
}

/** Enrolled devices summed across sources; null when no source has counted yet. */
export const deviceTotal = (sources: ReadonlyArray<DeviceSource>): number | null => {
	const counts = Arr.getSomes(Arr.map(sources, (source) => Option.fromNullishOr(source.deviceCount)))
	return counts.length === 0 ? null : Arr.reduce(counts, 0, (total, count) => total + count)
}

/** Some sources (Fleet Free) report no CVSS, EPSS or known-exploited flag: their columns are left out. */
export const hasScores = (vulnerabilities: ReadonlyArray<DeviceVulnerabilityFinding>): boolean =>
	Arr.some(vulnerabilities, (vulnerability) => vulnerability.cvssScore !== null)

/** The kinds whose CVEs carry no score at all, so the page can say why. */
export const unscoredKinds = (
	vulnerabilities: ReadonlyArray<DeviceVulnerabilityFinding>,
): ReadonlyArray<DeviceSourceKind> =>
	Arr.filter(
		Arr.dedupe(Arr.map(vulnerabilities, (vulnerability) => vulnerability.source)),
		(kind) =>
			!Arr.some(
				vulnerabilities,
				(vulnerability) => vulnerability.source === kind && vulnerability.cvssScore !== null,
			),
	)

/** Each source with CVEs past those listed: how many, named and linked to its own list. */
export const moreVulnerabilitiesBySource = (
	sources: ReadonlyArray<DeviceSource>,
): ReadonlyArray<Readonly<{ key: string; count: number; name: string; href: string | null }>> => {
	const many = sources.length > 1
	return Arr.map(
		Arr.filter(sources, (source) => source.moreVulnerabilities > 0),
		(source) => ({
			key: `${source.kind}:${source.connectionId}`,
			count: source.moreVulnerabilities,
			name: many ? sourceLabelOf(source) : brandOf(source.kind).name,
			href: source.vulnerabilitiesUrl,
		}),
	)
}

/** Known exploited CVEs across every source, counted by the API over all of them, not the listed. */
export const knownExploitedCount = (sources: ReadonlyArray<DeviceSource>): number =>
	Arr.reduce(sources, 0, (sum, source) => sum + source.knownExploitedVulnerabilities)

/** Who a policy applies to: its device group as the source names it, or every device. */
export const appliesToLabel = (policy: DevicePolicyFinding): string => policy.groupName ?? "All devices"

export const criticalCount = (policies: ReadonlyArray<DevicePolicyFinding>): number =>
	Arr.filter(policies, (policy) => policy.critical).length

/** The platforms a policy runs on (`["darwin", "windows"]`); none for a policy that runs on all of them. */
export const platformsOf = (platform: string | null): ReadonlyArray<string> =>
	Arr.filter(
		Arr.map(Str.split(",")(platform ?? ""), (part) => Str.trim(part)),
		Str.isNonEmpty,
	)

/** A platform's name; one the kit has no mark for is shown as the source spells it. */
export const platformName = (platform: string): string => osName(platform) ?? Str.capitalize(platform)

export const ALL_PLATFORMS = "All platforms"

/** "macOS, Windows" from "darwin,windows"; a policy with no platform runs on all of them. */
export const platformLabel = (platform: string | null): string => {
	const names = platformsOf(platform)
	return names.length === 0 ? ALL_PLATFORMS : Arr.join(Arr.map(names, platformName), ", ")
}

const plural = (count: number, one: string, many: string) =>
	`${formatNumber(count)} ${count === 1 ? one : many}`

export const devicesLabel = (count: number): string => plural(count, "device", "devices")

/** "12 of 240 devices failing", or "12 devices failing" when the source does not count passing ones. */
export const failingLabel = (policy: DevicePolicyFinding): string =>
	policy.passingDeviceCount === null
		? `${devicesLabel(policy.failingDeviceCount)} failing`
		: `${formatNumber(policy.failingDeviceCount)} of ${devicesLabel(policy.failingDeviceCount + policy.passingDeviceCount)} failing`

/** "openssl 3.0.2". */
export const softwareLabel = (software: VulnerableSoftware): string => `${software.name} ${software.version}`

/** CVSS reads as a severity: 9 and up critical, 7 high, 4 medium, else low. */
export const cvssTone = (score: number): "crit" | "warn" | "neutral" =>
	score >= 9 ? "crit" : score >= 7 ? "warn" : "neutral"

/** The all-clear for policies: the source's own words when every source is one kind. */
export const noFailingPoliciesText = (sources: ReadonlyArray<DeviceSource>): string => {
	const kinds = Arr.dedupe(Arr.map(sources, (source) => source.kind))
	const only = kinds.length === 1 ? kinds[0] : undefined
	return only === undefined
		? "Every enrolled device passes every policy your device sources report."
		: brandOf(only).noFailingPolicies
}
