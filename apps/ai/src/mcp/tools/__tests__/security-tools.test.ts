import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { InspectSecurityFindingOutput, ListSecurityFindingsOutput } from "@maple/domain/mcp-outputs"
import { RoleName } from "@maple/domain/primitives"
import type { McpToolResult } from "../types"
import { type FixtureRule, installFakeWarehouse, restoreWarehouse } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import {
	integrationFixtureRules,
	seedCommitWorld,
	seedIntegrationWorld,
} from "../../__evals__/integration-world"
import {
	SECURITY_WORLD,
	securityCatalogFetch,
	securityFixtureRules,
	seedSecurityWorld,
} from "../../__evals__/security-world"

const realFetch = globalThis.fetch
// Held, so a case can make one query fail: the fake warehouse reads this array on every call.
const rules: Array<FixtureRule> = [...securityFixtureRules(), ...integrationFixtureRules()]
let member: EvalRuntime
let admin: EvalRuntime
beforeAll(async () => {
	globalThis.fetch = securityCatalogFetch
	installFakeWarehouse(rules, undefined, "empty")
	member = makeEvalRuntime()
	await seedIntegrationWorld(member)
	await seedCommitWorld(member)
	await seedSecurityWorld(member)
	admin = { ...member, tenant: { ...member.tenant, roles: [Schema.decodeSync(RoleName)("org:admin")] } }
})
afterAll(async () => {
	globalThis.fetch = realFetch
	restoreWarehouse()
	await member.dispose()
})

const list = async (rt: EvalRuntime, params: Record<string, unknown>) => {
	const result: McpToolResult = await runToolDirect(rt, "list_security_findings", params)
	return {
		output: Schema.decodeUnknownSync(ListSecurityFindingsOutput)(result.structuredContent),
		text: markdown(result),
	}
}
const inspect = async (id: string) => {
	const result: McpToolResult = await runToolDirect(admin, "inspect_security_finding", { id })
	return {
		output: Schema.decodeUnknownSync(InspectSecurityFindingOutput)(result.structuredContent),
		text: markdown(result),
	}
}

describe("list_security_findings", () => {
	it("ranks every area's worst findings together in one call", async () => {
		const { output } = await list(admin, {})
		expect(output.areas.map((area) => [area.area, area.state])).toEqual([
			["code", "findings"],
			["dependencies", "findings"],
			["exposure", "findings"],
			["runtimes", "findings"],
		])
		const critical = output.findings.filter((row) => row.severity === "critical").map((row) => row.id)
		expect(critical).toEqual(
			expect.arrayContaining([
				SECURITY_WORLD.criticalFingerprint,
				"a1000000000000000000000000000001",
				"legacy-admin:/.env",
				"nodejs@22.4.0",
			]),
		)
		expect(output.findings.map((row) => SEVERITY_ORDER.indexOf(row.severity))).toEqual(
			output.findings.map((row) => SEVERITY_ORDER.indexOf(row.severity)).toSorted((a, b) => a - b),
		)
	})

	it("keeps code findings from members, as the dashboard does", async () => {
		const { output } = await list(member, { area: "code" })
		expect(output.areas[0]).toMatchObject({ area: "code", state: "forbidden" })
		expect(output.findings).toEqual([])
	})

	it("does not report a catch-all service's answered probes as exposures", async () => {
		const { output } = await list(admin, { area: "exposure" })
		expect(output.findings.map((row) => row.id)).toEqual(["legacy-admin:/.env", "billing:/actuator/env"])
		expect(output.notes.join("\n")).toContain(SECURITY_WORLD.catchAllService)
		expect(output.exposure?.sources[0]).toMatchObject({ address: "185.220.101.4", scanner: "nuclei" })
	})

	it("does not place a dev dependency in production", async () => {
		const { output } = await list(admin, { area: "dependencies" })
		const vitest = output.findings.find((row) => row.title.startsWith("vitest"))
		const next = output.findings.find((row) => row.title.startsWith("next"))
		expect(vitest?.services).toEqual([])
		expect(next?.services).toEqual([{ service: "checkout", environment: "production" }])
	})

	it("narrows code findings to a service through the repository it runs", async () => {
		const { output } = await list(admin, { service: "checkout" })
		const areas = new Set(output.findings.map((row) => row.area))
		expect(areas).toEqual(new Set(["code", "dependencies", "runtimes"]))
		expect(output.findings.some((row) => row.id === SECURITY_WORLD.criticalFingerprint)).toBe(true)
	})

	it("shows triaged findings and why only when asked for them", async () => {
		const open = await list(admin, { area: "code" })
		expect(open.output.findings.some((row) => row.status === "dismissed")).toBe(false)
		const all = await list(admin, { area: "code", status: "all" })
		const dismissed = all.output.findings.find((row) => row.status === "dismissed")
		expect(dismissed?.detail).toContain("single-use at the payment provider")
	})

	it("skips the per-service areas under a repository filter", async () => {
		const { output } = await list(admin, { repository: "acme/api" })
		expect(output.areas.map((area) => area.area)).toEqual(["code", "dependencies"])
		expect(output.areas.find((area) => area.area === "dependencies")?.summary).toContain(
			"never scanned: acme/api",
		)
	})

	it("matches a repository by its whole name, not a prefix", async () => {
		const { output } = await list(admin, { repository: "acme/sho" })
		expect(output.findings).toEqual([])
	})

	it("pages past the first findings and keeps the filters in the next call", async () => {
		const first = await list(admin, { status: "all", limit: 3 })
		const second = await list(admin, { status: "all", limit: 3, offset: 3 })
		expect(second.output.findings[0]?.id).not.toBe(first.output.findings[0]?.id)
		expect(first.text).toContain("offset=3")
		expect(first.text).toContain('status="all"')
	})

	it("says when an offset is past the last match", async () => {
		const { output, text } = await list(admin, { offset: 500 })
		expect(output.findings).toEqual([])
		expect(text).toContain("is past the last of the")
	})

	it("drills into an area over the window the overview read", async () => {
		const { output, text } = await list(admin, {})
		expect(text).toContain(`area="exposure" start_time="${output.window.startTime}"`)
	})

	it("says when a target's latest audit stopped early", async () => {
		const { output } = await list(admin, { area: "code" })
		expect(output.areas[0]?.summary).toContain(
			"acme/api@main's latest run is incomplete (org_spend_limit_reached)",
		)
	})
})

describe("inspect_security_finding", () => {
	it("answers whether a package CVE affects production, and what was not checked", async () => {
		const { output, text } = await inspect(SECURITY_WORLD.criticalCve)
		expect(output.matches).toMatchObject([
			{
				area: "dependencies",
				packageName: "next",
				fixedIn: "14.2.25",
				services: [{ service: "checkout" }],
			},
		])
		expect(output.coverage[0]).toBe(
			"Verdict: affected: checkout (production); unknown for acme/api (never scanned).",
		)
		// A package advisory says nothing about runtimes.
		expect(text).not.toContain("Runtimes:")
	})

	it("finds every runtime version a CVE affects and names the services checked clean", async () => {
		const { output } = await inspect(SECURITY_WORLD.nodeCve)
		const versions = output.matches.flatMap((m) =>
			m.area === "runtimes" ? [[m.version, m.fixedIn]] : [],
		)
		expect(versions).toEqual(
			expect.arrayContaining([
				["18.19.0", "18.20.6"],
				["22.4.0", "22.12.0"],
			]),
		)
		const runtimes = output.coverage.find((line) => line.startsWith("Runtimes:"))
		expect(runtimes).toContain("legacy-admin")
		expect(runtimes).toContain("not checkable: cart")
	})

	it("does not call a fixed package that no service runs an exposure", async () => {
		const { output } = await inspect(SECURITY_WORLD.fixedCve)
		expect(output.coverage[0]).toBe(
			"Verdict: not affected now; lodash in acme/shop is fixed; unknown for acme/api (never scanned).",
		)
	})

	it("reads a runtime version the list names for its posture alone", async () => {
		const { output } = await inspect("python@3.8.18")
		expect(output.matches).toMatchObject([
			{
				area: "runtimes",
				advisoryId: null,
				posture: "end_of_life",
				services: [{ service: "legacy-admin" }],
			},
		])
	})

	it("reads a supported runtime version as fine, with no upgrade", async () => {
		const { output, text } = await inspect("python@3.12.7")
		expect(output.matches).toMatchObject([
			{ area: "runtimes", posture: "supported", severity: "informational", fixedIn: null },
		])
		expect(text).not.toContain("Upgrade to")
	})

	it("reads a dependency finding by id", async () => {
		const { output } = await inspect("a1000000000000000000000000000002")
		expect(output.matches).toMatchObject([
			{ area: "dependencies", packageName: "axios", services: [{ service: "checkout" }] },
		])
	})

	it("says production is unknown when its telemetry cannot be read", async () => {
		// A fresh runtime: the running-commits read is cached per runtime, and this one must fail.
		const isolated = makeEvalRuntime()
		await seedIntegrationWorld(isolated)
		await seedCommitWorld(isolated)
		await seedSecurityWorld(isolated)
		rules.unshift({
			match: (sql) =>
				sql.includes(" AS commitSha") && sql.includes(" AS spanCount") && !sql.includes("lastSeen"),
			failure: { message: "warehouse unavailable", type: "UNKNOWN" },
		})
		try {
			const tenant = { ...isolated.tenant, roles: admin.tenant.roles }
			const result: McpToolResult = await runToolDirect(
				{ ...isolated, tenant },
				"inspect_security_finding",
				{
					id: SECURITY_WORLD.criticalCve,
				},
			)
			const output = Schema.decodeUnknownSync(InspectSecurityFindingOutput)(result.structuredContent)
			expect(output.coverage[0]).toContain(
				"unknown for which production services run it (could not be read)",
			)
			expect(output.coverage[0]).not.toContain("no production service is known to run it")
			// The lookup by id reads production on its own path.
			const byId: McpToolResult = await runToolDirect(
				{ ...isolated, tenant },
				"inspect_security_finding",
				{
					id: "a1000000000000000000000000000001",
				},
			)
			expect(
				Schema.decodeUnknownSync(InspectSecurityFindingOutput)(byId.structuredContent).notSearched,
			).toEqual([
				"production: telemetry could not be read, so which services run these packages is unknown",
			])
		} finally {
			rules.shift()
			await isolated.dispose()
		}
	})

	it("does not answer clean when no repository is connected", async () => {
		const empty = makeEvalRuntime()
		try {
			const tenant = { ...empty.tenant, roles: admin.tenant.roles }
			const result: McpToolResult = await runToolDirect(
				{ ...empty, tenant },
				"inspect_security_finding",
				{
					id: "CVE-1999-0001",
				},
			)
			const output = Schema.decodeUnknownSync(InspectSecurityFindingOutput)(result.structuredContent)
			expect(output.coverage[0]).toBe(
				"Verdict: not found in what Maple could read; unknown for dependencies (no repository is connected).",
			)
			expect(markdown(result)).not.toContain("no match means none of your scanned lockfiles")
		} finally {
			await empty.dispose()
		}
	})

	it("reads a code finding's trace, exploit and fix", async () => {
		const { output } = await inspect(SECURITY_WORLD.criticalFingerprint)
		const [finding] = output.matches
		expect(finding).toMatchObject({
			area: "code",
			verdict: "confirmed",
			severity: "critical",
			repository: "acme/shop",
		})
		expect(finding?.area === "code" ? finding.remediation?.strategy : undefined).toContain("orgId")
		expect(finding?.area === "code" ? finding.services : undefined).toEqual([
			{ service: "checkout", environment: "production" },
		])
	})

	it("reads an answered probe with every probe its service got", async () => {
		const { output } = await inspect("legacy-admin:/.env")
		const [probe] = output.matches
		expect(probe).toMatchObject({
			area: "exposure",
			httpStatus: 200,
			catchAll: false,
			severity: "critical",
		})
		expect(probe?.area === "exposure" ? probe.probes.map((p) => p.signature) : []).toEqual([
			"/.env",
			"/.git/",
			"/phpmyadmin",
		])
	})

	it("says nothing matched rather than guessing", async () => {
		const { output, text } = await inspect("CVE-1999-0001")
		expect(output.matches).toEqual([])
		expect(text).toContain("No security finding matches")
	})
})

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "informational", "unknown"]
