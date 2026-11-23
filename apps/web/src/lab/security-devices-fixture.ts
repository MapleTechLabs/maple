import { DevicesResponse } from "@maple/domain/http"
import { Array as Arr, Order, Schema } from "effect"

// Device findings for `/security/devices`: a Premium Fleet server of 240 devices, the same server on
// Fleet Free (no scores), the source states before and around a sync, and a second Fleet server.

const BASE = "https://fleet.acme.dev"
const CONNECTION_ID = "conn_fleet_acme"
type Encoded = typeof DevicesResponse.Encoded
type Source = Encoded["sources"][number]

/** Each source's known exploited count, as the API counts it: every CVE of the connection. */
const decode = (devices: Encoded) =>
	Schema.decodeSync(DevicesResponse)({
		...devices,
		sources: Arr.map(devices.sources, (source) => ({
			...source,
			knownExploitedVulnerabilities: Arr.filter(
				devices.vulnerabilities,
				(vulnerability) =>
					vulnerability.connectionId === source.connectionId &&
					vulnerability.knownExploited === true,
			).length,
		})),
	})

/** Where a fixture's findings come from: the Fleet server's address and connection. */
type Origin = Readonly<{ base: string; connectionId: string }>
const ACME: Origin = { base: BASE, connectionId: CONNECTION_ID }
const ACME_EU: Origin = { base: "https://fleet-eu.acme.dev", connectionId: "conn_fleet_acme_eu" }

const HOSTS = [
	["mbp-anna", "darwin"],
	["mbp-jonas", "darwin"],
	["mbp-priya", "darwin"],
	["mbp-lukas", "darwin"],
	["dell-xps-mara", "windows"],
	["thinkpad-omar", "windows"],
	["mbp-sofia", "darwin"],
	["mbp-felix", "darwin"],
	["surface-lea", "windows"],
	["mbp-noah", "darwin"],
	["mbp-elena", "darwin"],
	["build-runner-03", "ubuntu"],
] as const

const hosts = (count: number, offset = 0, origin: Origin = ACME) =>
	Arr.map(
		Arr.take(Arr.appendAll(Arr.drop(HOSTS, offset), Arr.take(HOSTS, offset)), count),
		([name, platform], index) => {
			const id = String(100 + offset * 13 + index)
			return { id, name, platform, url: `${origin.base}/hosts/${id}` }
		},
	)

const source = (nowMs: number, overrides: Partial<Source> = {}): Source => ({
	kind: "fleet",
	connectionId: CONNECTION_ID,
	label: "Acme",
	url: BASE,
	deviceCount: 240,
	syncedAt: nowMs - 4 * 60_000,
	error: null,
	authFailed: false,
	vulnerabilitiesUrl: `${BASE}/software/vulnerabilities`,
	moreVulnerabilities: 0,
	knownExploitedVulnerabilities: 0,
	...overrides,
})

/** Not synced yet: no count and no list to point at. */
const unsynced: Partial<Source> = { deviceCount: null, syncedAt: null, vulnerabilitiesUrl: null }

const finding = (origin: Origin): Readonly<{ source: "fleet"; connectionId: string }> => ({
	source: "fleet",
	connectionId: origin.connectionId,
})

const policies = (nowMs: number): Encoded["policies"] => [
	{
		...finding(ACME),
		policyId: "12",
		name: "Disk encryption enabled",
		groupName: "Workstations",
		description: "FileVault on macOS and BitLocker on Windows protect data on a lost or stolen laptop.",
		resolution:
			"On macOS, open System Settings, Privacy and Security, FileVault and turn it on. On Windows, turn on BitLocker in Settings, Privacy and security, Device encryption.",
		critical: true,
		platform: "darwin,windows",
		failingDeviceCount: 7,
		passingDeviceCount: 229,
		failingDevices: hosts(7),
		countedAt: nowMs - 30 * 60_000,
		firstSeenAt: nowMs - 6 * 86_400_000,
		url: `${BASE}/policies/12`,
	},
	{
		...finding(ACME),
		policyId: "4",
		name: "Operating system is up to date",
		groupName: null,
		description: "Devices run the latest minor release of their operating system.",
		resolution: "Install the pending system update and restart.",
		critical: false,
		platform: null,
		failingDeviceCount: 31,
		passingDeviceCount: 209,
		failingDevices: hosts(12, 2),
		countedAt: nowMs - 30 * 60_000,
		firstSeenAt: nowMs - 20 * 86_400_000,
		url: `${BASE}/policies/4`,
	},
	{
		...finding(ACME),
		policyId: "9",
		name: "Screen locks after 5 minutes",
		groupName: "Workstations",
		description: null,
		resolution: "Set the screen to lock after at most 5 minutes of inactivity.",
		critical: false,
		platform: "darwin",
		failingDeviceCount: 4,
		passingDeviceCount: 182,
		failingDevices: hosts(4, 5),
		countedAt: nowMs - 30 * 60_000,
		firstSeenAt: nowMs - 2 * 86_400_000,
		url: `${BASE}/policies/9`,
	},
	{
		...finding(ACME),
		policyId: "17",
		name: "Firewall enabled",
		groupName: "💻 Windows laptops (Berlin and remote contractors)",
		description: "The built-in firewall is on.",
		resolution: null,
		critical: false,
		platform: "windows",
		failingDeviceCount: 2,
		passingDeviceCount: 52,
		failingDevices: hosts(2, 4),
		countedAt: nowMs - 30 * 60_000,
		firstSeenAt: nowMs - 86_400_000,
		url: `${BASE}/policies/17`,
	},
]

type Cve = readonly [
	cve: string,
	cvss: number,
	epss: number,
	kev: boolean,
	software: ReadonlyArray<readonly [name: string, version: string, hosts: number, fixedIn: string | null]>,
]

const CVES: ReadonlyArray<Cve> = [
	["CVE-2024-7971", 9.6, 0.62, true, [["Google Chrome", "127.0.6533.99", 18, "128.0.6613.84"]]],
	[
		"CVE-2024-5535",
		9.1,
		0.04,
		false,
		[
			["openssl", "3.0.2", 41, "3.0.15"],
			["openssl", "3.1.4", 6, "3.1.7"],
		],
	],
	["CVE-2024-27322", 8.8, 0.03, false, [["R", "4.3.2", 2, "4.4.0"]]],
	["CVE-2024-6387", 8.1, 0.43, false, [["openssh", "9.6p1", 3, "9.8p1"]]],
	["CVE-2024-45489", 8.1, 0.01, false, [["Zoom", "6.0.11", 27, "6.1.5"]]],
	["CVE-2024-7969", 8.8, 0.02, false, [["Google Chrome", "127.0.6533.99", 18, "128.0.6613.84"]]],
	["CVE-2024-38063", 9.8, 0.09, false, [["Windows 11", "23H2", 12, null]]],
	["CVE-2024-4741", 7.5, 0.01, false, [["openssl", "3.0.2", 41, "3.0.14"]]],
	["CVE-2024-24795", 6.3, 0.02, false, [["Slack", "4.36.140", 9, "4.38.115"]]],
	["CVE-2024-27983", 8.2, 0.05, false, [["node", "20.11.0", 5, "20.12.1"]]],
	["CVE-2023-49803", 5.3, 0.01, false, [["Zoom", "6.0.11", 27, null]]],
	["CVE-2024-2511", 5.9, 0.01, false, [["openssl", "3.1.4", 6, "3.1.6"]]],
]

const sum = (cve: Cve): number => Arr.reduce(cve[4], 0, (total, [, , count]) => total + count)

const byDevices = Order.mapInput(Order.flip(Order.Number), sum)
const byScore = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (cve: Cve) => cve[1]),
	byDevices,
)

const vulnerabilities = (
	nowMs: number,
	scored: boolean,
	cves: ReadonlyArray<Cve> = CVES,
	origin: Origin = ACME,
): Encoded["vulnerabilities"] =>
	Arr.map(Arr.sort(cves, scored ? byScore : byDevices), (cve) => ({
		...finding(origin),
		cve: cve[0],
		cvssScore: scored ? cve[1] : null,
		epssProbability: scored ? cve[2] : null,
		knownExploited: scored ? cve[3] : null,
		detailsLink: `https://nvd.nist.gov/vuln/detail/${cve[0]}`,
		deviceCount: sum(cve),
		software: Arr.map(cve[4], ([name, version, deviceCount, resolvedInVersion]) => ({
			name,
			version,
			packageSource: "apps",
			deviceCount,
			resolvedInVersion,
		})),
		firstSeenAt: nowMs - 3 * 86_400_000,
		url: `${origin.base}/software/vulnerabilities/${cve[0]}`,
	}))

export const notConnectedDevices = decode({
	sources: [],
	policies: [],
	vulnerabilities: [],
	moreVulnerabilities: 0,
})

export const firstSyncDevices = (nowMs: number) =>
	decode({ sources: [source(nowMs, unsynced)], policies: [], vulnerabilities: [], moreVulnerabilities: 0 })

export const firstSyncFailedDevices = (nowMs: number) =>
	decode({
		sources: [source(nowMs, { ...unsynced, error: "Fleet answered 500." })],
		policies: [],
		vulnerabilities: [],
		moreVulnerabilities: 0,
	})

export const premiumDevices = (nowMs: number) =>
	decode({
		sources: [source(nowMs, { moreVulnerabilities: 37 })],
		policies: policies(nowMs),
		vulnerabilities: vulnerabilities(nowMs, true),
		moreVulnerabilities: 37,
	})

export const freeDevices = (nowMs: number) =>
	decode({
		sources: [source(nowMs, { label: null })],
		policies: policies(nowMs),
		vulnerabilities: vulnerabilities(nowMs, false),
		moreVulnerabilities: 0,
	})

export const authFailedDevices = (nowMs: number) =>
	decode({
		sources: [
			source(nowMs, {
				syncedAt: nowMs - 5 * 3_600_000,
				authFailed: true,
				error: "Fleet answered 401: Authentication required.",
				moreVulnerabilities: 37,
			}),
		],
		policies: policies(nowMs),
		vulnerabilities: vulnerabilities(nowMs, true),
		moreVulnerabilities: 37,
	})

export const syncErrorDevices = (nowMs: number) =>
	decode({
		sources: [
			source(nowMs, {
				syncedAt: nowMs - 2 * 3_600_000,
				error: "Fleet did not answer within 30 seconds.",
				moreVulnerabilities: 37,
			}),
		],
		policies: policies(nowMs),
		vulnerabilities: vulnerabilities(nowMs, true),
		moreVulnerabilities: 37,
	})

export const allClearDevices = (nowMs: number) =>
	decode({ sources: [source(nowMs)], policies: [], vulnerabilities: [], moreVulnerabilities: 0 })

/** The EU office's own Fleet server: smaller, and its token was revoked an hour after its last sync. */
const euSource = (nowMs: number): Source =>
	source(nowMs, {
		connectionId: ACME_EU.connectionId,
		label: "Acme EU",
		url: ACME_EU.base,
		deviceCount: 64,
		syncedAt: nowMs - 70 * 60_000,
		authFailed: true,
		error: "Fleet answered 401: Authentication required.",
		vulnerabilitiesUrl: `${ACME_EU.base}/software/vulnerabilities`,
	})

/** Policy 12 exists on both servers: ids are only unique within one connection. */
const euPolicies = (nowMs: number): Encoded["policies"] => [
	{
		...finding(ACME_EU),
		policyId: "12",
		name: "Disk encryption enabled",
		groupName: null,
		description: "FileVault on macOS and BitLocker on Windows protect data on a lost or stolen laptop.",
		resolution: null,
		critical: true,
		platform: "darwin,windows",
		failingDeviceCount: 3,
		// A source that does not count passing devices.
		passingDeviceCount: null,
		failingDevices: hosts(3, 8, ACME_EU),
		countedAt: nowMs - 70 * 60_000,
		firstSeenAt: nowMs - 9 * 86_400_000,
		url: `${ACME_EU.base}/policies/12`,
	},
]

const EU_CVES: ReadonlyArray<Cve> = [
	["CVE-2024-7971", 9.6, 0.62, true, [["Google Chrome", "127.0.6533.99", 5, "128.0.6613.84"]]],
	["CVE-2024-6387", 8.1, 0.43, false, [["openssh", "9.6p1", 9, "9.8p1"]]],
]

const byCritical = Order.mapInput(
	Order.flip(Order.Boolean),
	(policy: Encoded["policies"][number]) => policy.critical,
)
const byFailing = Order.mapInput(
	Order.flip(Order.Number),
	(policy: Encoded["policies"][number]) => policy.failingDeviceCount,
)
const byCvss = Order.mapInput(
	Order.flip(Order.Number),
	(vulnerability: Encoded["vulnerabilities"][number]) => vulnerability.cvssScore ?? 0,
)

/** Two Fleet servers merged the way the API merges sources: critical first, then by score. */
export const twoSourceDevices = (nowMs: number) =>
	decode({
		sources: [source(nowMs, { moreVulnerabilities: 37 }), euSource(nowMs)],
		policies: Arr.sort(
			Arr.appendAll(policies(nowMs), euPolicies(nowMs)),
			Order.combine(byCritical, byFailing),
		),
		vulnerabilities: Arr.sort(
			Arr.appendAll(vulnerabilities(nowMs, true), vulnerabilities(nowMs, true, EU_CVES, ACME_EU)),
			byCvss,
		),
		moreVulnerabilities: 37,
	})
