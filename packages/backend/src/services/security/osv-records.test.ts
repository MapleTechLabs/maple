import type { PackageRef } from "@maple/domain/package-advisories"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import fixture from "./__fixtures__/osv.json"
import { advisoriesOf, type OsvRecord, OsvVulnResponse, toOsvRecord } from "./osv-records"

// `fixture` is a real OSV answer, captured by scripts/capture-osv-fixtures.ts.
const records = fixture.vulns.map((vuln) => toOsvRecord(Schema.decodeUnknownSync(OsvVulnResponse)(vuln)))

const recordsFor = (ref: PackageRef): ReadonlyArray<OsvRecord> => {
	const index = fixture.queries.findIndex(
		(query) => query.package.name === ref.name && query.version === ref.version,
	)
	const ids = new Set((fixture.batch.results[index]?.vulns ?? []).map((vuln) => vuln.id))
	return records.filter((record) => ids.has(record.id))
}

const advisoriesFor = (ref: PackageRef) => advisoriesOf(recordsFor(ref), ref)

const record = (overrides: Partial<OsvRecord>): OsvRecord => ({
	id: "GO-2026-0001",
	aliases: [],
	summary: null,
	published: null,
	withdrawn: false,
	curatedSeverity: null,
	cvssV3: null,
	affected: [
		{ ecosystem: "Go", name: "example.com/mod", events: [{ introduced: "0" }, { fixed: "1.4.0" }] },
	],
	...overrides,
})

const GO_REF: PackageRef = { ecosystem: "Go", name: "example.com/mod", version: "v1.2.0" }

describe("advisoriesOf", () => {
	it("merges a Go vulnerability's GO- and GHSA- records into one advisory under the GHSA id", () => {
		const advisories = advisoriesFor({ ecosystem: "Go", name: "golang.org/x/net", version: "v0.7.0" })
		const xss = advisories.filter((advisory) => advisory.aliases.includes("CVE-2023-3978"))
		expect(xss).toHaveLength(1)
		expect(xss[0]).toMatchObject({
			id: "GHSA-2wrh-6pvc-2jm9",
			severity: "medium",
			fixedIn: "v0.13.0",
		})
		expect(xss[0]?.aliases).toContain("GO-2023-1988")
		expect(new Set(advisories.map((advisory) => advisory.id)).size).toBe(advisories.length)
	})

	it("reads GitHub's MODERATE as medium and picks the fix of the locked version's range", () => {
		const advisories = advisoriesFor({ ecosystem: "npm", name: "lodash", version: "4.17.15" })
		expect(advisories.find((advisory) => advisory.id === "GHSA-p6mc-m468-83gw")).toMatchObject({
			severity: "high",
			fixedIn: "4.17.19",
		})
		expect(advisories.find((advisory) => advisory.id === "GHSA-29mw-wpgm-hmr9")?.severity).toBe("medium")
	})

	it("merges a RUSTSEC record with its GHSA twin", () => {
		const advisories = advisoriesFor({ ecosystem: "crates.io", name: "time", version: "0.1.43" })
		expect(advisories).toHaveLength(1)
		expect(advisories[0]?.aliases).toEqual(
			expect.arrayContaining(["RUSTSEC-2020-0071", "CVE-2020-26235"]),
		)
	})

	it("rates a record without a curated severity from its CVSS 3 vector", () => {
		const [advisory] = advisoriesOf(
			[record({ cvssV3: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" })],
			GO_REF,
		)
		expect(advisory?.severity).toBe("high")
		expect(advisory?.fixedIn).toBe("v1.4.0")
	})

	it("takes the worst rating and the highest fix when the records disagree", () => {
		const [advisory] = advisoriesOf(
			[
				record({ id: "GO-2026-0001", aliases: ["CVE-2026-1"] }),
				record({
					id: "GHSA-aaaa-bbbb-cccc",
					aliases: ["CVE-2026-1"],
					curatedSeverity: "LOW",
					cvssV3: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
					affected: [
						{
							ecosystem: "Go",
							name: "example.com/mod",
							events: [{ introduced: "0" }, { fixed: "1.5.0" }],
						},
					],
				}),
				record({ id: "OSV-2026-9", aliases: ["CVE-2026-1"], curatedSeverity: "HIGH" }),
			],
			GO_REF,
		)
		expect(advisory).toMatchObject({ id: "GHSA-aaaa-bbbb-cccc", severity: "high", fixedIn: "v1.5.0" })
	})

	it("leaves out withdrawn records and ranges of other packages", () => {
		expect(advisoriesOf([record({ withdrawn: true })], GO_REF)).toEqual([])
		const [advisory] = advisoriesOf(
			[
				record({
					affected: [
						{
							ecosystem: "Go",
							name: "example.com/other",
							events: [{ introduced: "0" }, { fixed: "1.3.0" }],
						},
					],
				}),
			],
			GO_REF,
		)
		expect(advisory?.fixedIn).toBeNull()
	})
})
