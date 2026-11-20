import type {
	FleetDevicesConnection,
	FleetPolicyFinding,
	FleetVulnerabilityFinding,
} from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import type { Devices, Model } from "./model"

// Pure readings of the Devices page: which state it is in, and the words each row shows.

/** The Fleet card on `/integrations`, where a token is saved or replaced. */
export const FLEET_CARD_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "fleet" } }))

export type Screen =
	| Readonly<{ _tag: "Loading" }>
	| Readonly<{ _tag: "Forbidden" }>
	| Readonly<{ _tag: "Failed"; failure: LoadFailure }>
	| Readonly<{ _tag: "NotConnected" }>
	| Readonly<{ _tag: "Connected"; connection: FleetDevicesConnection; devices: Devices }>

/** A viewer without `security:manage` gets the integrations 403. */
const isForbidden = (failure: LoadFailure): boolean => failure.code === "integration_forbidden"

export const screenOf = (model: Pick<Model, "devices">): Screen =>
	AsyncData.matchData(model.devices.data, {
		onEmpty: (): Screen => ({ _tag: "Loading" }),
		onFailure: (failure): Screen =>
			isForbidden(failure) ? { _tag: "Forbidden" } : { _tag: "Failed", failure },
		onData: (devices): Screen =>
			devices.connection === null
				? { _tag: "NotConnected" }
				: { _tag: "Connected", connection: devices.connection, devices },
	})

/** The server's name as Fleet reports it, else its host. */
export const serverNameOf = (connection: FleetDevicesConnection): string =>
	connection.organizationName ?? Str.replace(/^https?:\/\//, "")(connection.baseUrl)

/** Fleet Free reports no CVSS, EPSS or known-exploited flag: their columns are left out. */
export const hasScores = (vulnerabilities: ReadonlyArray<FleetVulnerabilityFinding>): boolean =>
	Arr.some(vulnerabilities, (vulnerability) => vulnerability.cvssScore !== null)

export const knownExploitedCount = (vulnerabilities: ReadonlyArray<FleetVulnerabilityFinding>): number =>
	Arr.filter(vulnerabilities, (vulnerability) => vulnerability.knownExploited === true).length

export const criticalCount = (policies: ReadonlyArray<FleetPolicyFinding>): number =>
	Arr.filter(policies, (policy) => policy.critical).length

const PLATFORM_LABEL = new Map([
	["darwin", "macOS"],
	["windows", "Windows"],
	["linux", "Linux"],
	["chrome", "ChromeOS"],
	["ios", "iOS"],
	["ipados", "iPadOS"],
	["android", "Android"],
])

const platformName = (platform: string): string => PLATFORM_LABEL.get(platform) ?? Str.capitalize(platform)

/** "macOS, Windows" from Fleet's "darwin,windows"; a policy with no platform runs on all of them. */
export const platformLabel = (platform: string | null): string => {
	const names = Arr.filter(
		Arr.map(Str.split(",")(platform ?? ""), (part) => Str.trim(part)),
		Str.isNonEmpty,
	)
	return names.length === 0 ? "All platforms" : Arr.join(Arr.map(names, platformName), ", ")
}

const plural = (count: number, one: string, many: string) =>
	`${formatNumber(count)} ${count === 1 ? one : many}`

export const devicesLabel = (count: number): string => plural(count, "device", "devices")

/** "12 of 240 devices failing". */
export const failingLabel = (policy: FleetPolicyFinding): string =>
	`${formatNumber(policy.failingHostCount)} of ${devicesLabel(policy.failingHostCount + policy.passingHostCount)} failing`

/** "openssl 3.0.2", with the version that fixes it when Fleet knows one. */
export const softwareLabel = (software: FleetVulnerabilityFinding["software"][number]): string =>
	`${software.name} ${software.version}`

/** CVSS reads as a severity: 9 and up critical, 7 high, 4 medium, else low. */
export const cvssTone = (score: number): "crit" | "warn" | "neutral" =>
	score >= 9 ? "crit" : score >= 7 ? "warn" : "neutral"

/** The CVE list on the Fleet server, for what Maple does not list. */
export const fleetVulnerabilitiesHref = (connection: FleetDevicesConnection): string =>
	`${Str.replace(/\/+$/, "")(connection.baseUrl)}/software/vulnerabilities`
