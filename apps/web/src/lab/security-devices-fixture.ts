import { FleetDevicesResponse } from "@maple/domain/http"
import { Array as Arr, Order, Schema } from "effect"

// Fleet device findings for `/security/devices`: a Premium fleet of 240 devices, the same fleet on
// Fleet Free (no scores), and the connection states before and around a sync.

const BASE = "https://fleet.acme.dev"
const decode = Schema.decodeSync(FleetDevicesResponse)
type Encoded = typeof FleetDevicesResponse.Encoded

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

const hosts = (count: number, offset = 0) =>
	Arr.map(
		Arr.take(Arr.appendAll(Arr.drop(HOSTS, offset), Arr.take(HOSTS, offset)), count),
		([name, platform], index) => {
			const id = 100 + offset * 13 + index
			return { id, name, platform, url: `${BASE}/hosts/${id}` }
		},
	)

const connection = (nowMs: number, overrides: Partial<NonNullable<Encoded["connection"]>> = {}) => ({
	organizationName: "Acme",
	baseUrl: BASE,
	licenseTier: "premium",
	hostCount: 240,
	syncedAt: nowMs - 4 * 60_000,
	error: null,
	authFailed: false,
	...overrides,
})

const policies = (nowMs: number): Encoded["policies"] => [
	{
		policyId: 12,
		name: "Disk encryption enabled",
		description: "FileVault on macOS and BitLocker on Windows protect data on a lost or stolen laptop.",
		resolution:
			"On macOS, open System Settings, Privacy and Security, FileVault and turn it on. On Windows, turn on BitLocker in Settings, Privacy and security, Device encryption.",
		critical: true,
		platform: "darwin,windows",
		failingHostCount: 7,
		passingHostCount: 229,
		failingHosts: hosts(7),
		countedAt: nowMs - 30 * 60_000,
		firstSeenAt: nowMs - 6 * 86_400_000,
		url: `${BASE}/policies/12`,
	},
	{
		policyId: 4,
		name: "Operating system is up to date",
		description: "Devices run the latest minor release of their operating system.",
		resolution: "Install the pending system update and restart.",
		critical: false,
		platform: null,
		failingHostCount: 31,
		passingHostCount: 209,
		failingHosts: hosts(12, 2),
		countedAt: nowMs - 30 * 60_000,
		firstSeenAt: nowMs - 20 * 86_400_000,
		url: `${BASE}/policies/4`,
	},
	{
		policyId: 9,
		name: "Screen locks after 5 minutes",
		description: null,
		resolution: "Set the screen to lock after at most 5 minutes of inactivity.",
		critical: false,
		platform: "darwin",
		failingHostCount: 4,
		passingHostCount: 182,
		failingHosts: hosts(4, 5),
		countedAt: nowMs - 30 * 60_000,
		firstSeenAt: nowMs - 2 * 86_400_000,
		url: `${BASE}/policies/9`,
	},
	{
		policyId: 17,
		name: "Firewall enabled",
		description: "The built-in firewall is on.",
		resolution: null,
		critical: false,
		platform: "windows",
		failingHostCount: 2,
		passingHostCount: 52,
		failingHosts: hosts(2, 4),
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

const vulnerabilities = (nowMs: number, scored: boolean): Encoded["vulnerabilities"] =>
	Arr.map(Arr.sort(CVES, scored ? byScore : byDevices), (cve) => ({
		cve: cve[0],
		cvssScore: scored ? cve[1] : null,
		epssProbability: scored ? cve[2] : null,
		knownExploited: scored ? cve[3] : null,
		detailsLink: `https://nvd.nist.gov/vuln/detail/${cve[0]}`,
		hostCount: sum(cve),
		software: Arr.map(cve[4], ([name, version, hostCount, resolvedInVersion]) => ({
			name,
			version,
			source: "apps",
			hostCount,
			resolvedInVersion,
		})),
		firstSeenAt: nowMs - 3 * 86_400_000,
		url: `${BASE}/software/vulnerabilities/${cve[0]}`,
	}))

export const notConnectedDevices = decode({
	connection: null,
	policies: [],
	vulnerabilities: [],
	moreVulnerabilities: 0,
})

export const firstSyncDevices = (nowMs: number) =>
	decode({
		connection: connection(nowMs, { hostCount: null, syncedAt: null, licenseTier: null }),
		policies: [],
		vulnerabilities: [],
		moreVulnerabilities: 0,
	})

export const premiumDevices = (nowMs: number) =>
	decode({
		connection: connection(nowMs),
		policies: policies(nowMs),
		vulnerabilities: vulnerabilities(nowMs, true),
		moreVulnerabilities: 37,
	})

export const freeDevices = (nowMs: number) =>
	decode({
		connection: connection(nowMs, { licenseTier: "free", organizationName: null }),
		policies: policies(nowMs),
		vulnerabilities: vulnerabilities(nowMs, false),
		moreVulnerabilities: 0,
	})

export const authFailedDevices = (nowMs: number) =>
	decode({
		connection: connection(nowMs, {
			syncedAt: nowMs - 5 * 3_600_000,
			authFailed: true,
			error: "Fleet answered 401: Authentication required.",
		}),
		policies: policies(nowMs),
		vulnerabilities: vulnerabilities(nowMs, true),
		moreVulnerabilities: 37,
	})

export const syncErrorDevices = (nowMs: number) =>
	decode({
		connection: connection(nowMs, {
			syncedAt: nowMs - 2 * 3_600_000,
			error: "Fleet did not answer within 30 seconds.",
		}),
		policies: policies(nowMs),
		vulnerabilities: vulnerabilities(nowMs, true),
		moreVulnerabilities: 37,
	})

export const allClearDevices = (nowMs: number) =>
	decode({ connection: connection(nowMs), policies: [], vulnerabilities: [], moreVulnerabilities: 0 })
