import { assert, describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { failingPolicies, findingDevice, vulnerabilitiesBySoftware } from "./findings"

const BASE = "https://fleet.example.com"

describe("failingPolicies", () => {
	it("keeps only failing policies, critical first, and reads blanks as absent", () => {
		const found = failingPolicies(
			[
				{ id: 1, name: "Firewall", failing_host_count: 5, resolution: "" },
				{
					id: 2,
					name: "Encryption",
					critical: true,
					failing_host_count: 1,
					host_count_updated_at: "2026-11-19T10:00:00Z",
				},
				{ id: 3, name: "Passing", failing_host_count: 0 },
				{ id: 4, name: "Never counted", failing_host_count: null },
			],
			BASE,
		)
		assert.deepStrictEqual(
			Arr.map(found, ({ fleetId, finding }) => [
				fleetId,
				finding.policyId,
				finding.critical,
				finding.resolution,
				finding.countedAt,
				finding.url,
			]),
			[
				[2, "2", true, null, Date.UTC(2026, 10, 19, 10), `${BASE}/policies/2`],
				[1, "1", false, null, null, `${BASE}/policies/1`],
			],
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
