import { assert, describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { failingPolicies, findingDevice, vulnerabilitiesByCve, vulnerabilitiesBySoftware } from "./findings"

const BASE = "https://fleet.example.com"

describe("failingPolicies", () => {
	it("keeps only failing policies, critical first, and reads blanks as absent", () => {
		const found = failingPolicies(
			[
				{
					policy: { id: 1, name: "Firewall", failing_host_count: 5, resolution: "" },
					groupName: null,
				},
				{
					policy: {
						id: 2,
						name: "Encryption",
						critical: true,
						failing_host_count: 1,
						host_count_updated_at: "2026-11-19T10:00:00Z",
					},
					groupName: "Workstations",
				},
				{ policy: { id: 3, name: "Passing", failing_host_count: 0 }, groupName: "Workstations" },
				{ policy: { id: 4, name: "Never counted", failing_host_count: null }, groupName: null },
			],
			BASE,
		)
		assert.deepStrictEqual(
			Arr.map(found, ({ numericId, finding }) => [
				numericId,
				finding.policyId,
				finding.groupName,
				finding.critical,
				finding.resolution,
				finding.countedAt,
				finding.url,
			]),
			[
				[2, "2", "Workstations", true, null, Date.UTC(2026, 10, 19, 10), `${BASE}/policies/2`],
				[1, "1", null, false, null, null, `${BASE}/policies/1`],
			],
		)
	})
})

describe("failingPolicies passing counts", () => {
	it("keeps a passing count Fleet has not computed as unknown, not zero", () => {
		const [counted, uncounted] = failingPolicies(
			[
				{
					policy: { id: 1, name: "Firewall", failing_host_count: 5, passing_host_count: 20 },
					groupName: null,
				},
				{
					policy: { id: 2, name: "Encryption", failing_host_count: 3, passing_host_count: null },
					groupName: null,
				},
			],
			BASE,
		)
		assert.deepStrictEqual(
			[counted?.finding.passingDeviceCount, uncounted?.finding.passingDeviceCount],
			[20, null],
		)
	})
})

describe("findingDevice", () => {
	it("names a device by its display name, its hostname, or its id, and links to it", () => {
		assert.deepStrictEqual(
			Arr.map(
				[
					{ id: 1, display_name: "Jane's Mac", hostname: "jane-mbp" },
					{ id: 2, display_name: "", hostname: "build-box" },
					{ id: 3 },
				],
				(host) => {
					const device = findingDevice(host, BASE)
					return [device.id, device.name, device.url]
				},
			),
			[
				["1", "Jane's Mac", `${BASE}/hosts/1`],
				["2", "build-box", `${BASE}/hosts/2`],
				["3", "host 3", `${BASE}/hosts/3`],
			],
		)
	})
})

describe("vulnerabilitiesBySoftware", () => {
	it("leaves scores empty on Fleet Free and puts unscored CVEs last", () => {
		const found = vulnerabilitiesBySoftware(
			[
				{ id: 1, name: "curl", version: "8.0", hosts_count: 30, vulnerabilities: [{ cve: "CVE-A" }] },
				{
					id: 2,
					name: "zlib",
					version: "1.2",
					hosts_count: 1,
					vulnerabilities: [
						{ cve: "CVE-B", cvss_score: 5, cisa_known_exploit: true, resolved_in_version: "1.3" },
					],
				},
			],
			BASE,
		)
		assert.deepStrictEqual(
			Arr.map(found, (finding) => [
				finding.cve,
				finding.cvssScore,
				finding.knownExploited,
				finding.url,
			]),
			[
				["CVE-B", 5, true, `${BASE}/software/vulnerabilities/CVE-B`],
				["CVE-A", null, null, `${BASE}/software/vulnerabilities/CVE-A`],
			],
		)
		assert.strictEqual(found[0]?.software[0]?.resolvedInVersion, "1.3")
	})

	it("keeps only https detail links, since the server chooses them", () => {
		const links = Arr.map(
			["https://nvd.nist.gov/vuln/detail/CVE-A", "javascript:alert(1)", "http://example.com", ""],
			(link) =>
				vulnerabilitiesBySoftware(
					[
						{
							id: 1,
							name: "a",
							version: "1",
							hosts_count: 1,
							vulnerabilities: [{ cve: "CVE-A", details_link: link }],
						},
					],
					BASE,
				)[0]?.detailsLink,
		)
		assert.deepStrictEqual(links, ["https://nvd.nist.gov/vuln/detail/CVE-A", null, null, null])
	})
})

describe("vulnerabilitiesByCve", () => {
	const software = [
		{
			id: 1,
			name: "openssl",
			version: "3.0.1",
			hosts_count: 5,
			vulnerabilities: [
				{
					cve: "CVE-A",
					cvss_score: 5,
					cisa_known_exploit: false,
					details_link: "https://software.example/CVE-A",
					resolved_in_version: "3.0.2",
				},
			],
		},
		{
			id: 2,
			name: "openssl-libs",
			version: "3.0.1",
			hosts_count: 5,
			vulnerabilities: [{ cve: "CVE-A", cvss_score: 6 }],
		},
	]

	it("takes Fleet's device count, score, exploit flag and link over the software's", () => {
		const [finding] = vulnerabilitiesByCve(
			[
				{
					cve: "CVE-A",
					hosts_count: 5,
					cvss_score: 9.1,
					cisa_known_exploit: true,
					details_link: "https://nvd.nist.gov/vuln/detail/CVE-A",
				},
			],
			software,
			BASE,
		)
		assert.deepStrictEqual(
			[
				finding?.deviceCount,
				finding?.cvssScore,
				finding?.knownExploited,
				finding?.detailsLink,
				finding?.software.length,
			],
			[5, 9.1, true, "https://nvd.nist.gov/vuln/detail/CVE-A", 2],
		)
	})

	it("falls back to the software for what Fleet's row leaves out (Fleet Free has no scores)", () => {
		const [finding] = vulnerabilitiesByCve([{ cve: "CVE-A", hosts_count: 5 }], software, BASE)
		assert.deepStrictEqual(
			[finding?.deviceCount, finding?.cvssScore, finding?.knownExploited, finding?.detailsLink],
			[5, 6, false, "https://software.example/CVE-A"],
		)
	})

	it("keeps a CVE the software read did not reach, with no software listed", () => {
		const [finding] = vulnerabilitiesByCve([{ cve: "CVE-Z", hosts_count: 2 }], software, BASE)
		assert.deepStrictEqual(
			[finding?.cve, finding?.deviceCount, finding?.software, finding?.cvssScore],
			["CVE-Z", 2, [], null],
		)
	})
})
