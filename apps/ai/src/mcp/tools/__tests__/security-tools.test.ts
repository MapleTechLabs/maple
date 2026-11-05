import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema, Array as Arr, String as Str } from "effect"
import {
	InspectSecurityAuditRunOutput,
	InspectSecurityFindingOutput,
	ListSecurityAuditRunsOutput,
	ListSecurityFindingsOutput,
} from "@maple/domain/mcp-outputs"
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
		expect(Arr.map(output.areas, (area) => [area.area, area.state])).toEqual([
			["code", "findings"],
			["dependencies", "findings"],
			["exposure", "findings"],
			["runtimes", "findings"],
		])
		const critical = Arr.map(
			Arr.filter(output.findings, (row) => row.severity === "critical"),
			(row) => row.id,
		)
		expect(critical).toEqual(
			expect.arrayContaining([
				SECURITY_WORLD.criticalFingerprint,
				"a1000000000000000000000000000001",
				"legacy-admin:/.env",
				"nodejs@22.4.0",
			]),
		)
		expect(Arr.map(output.findings, (row) => SEVERITY_ORDER.indexOf(row.severity))).toEqual(
			Arr.map(output.findings, (row) => SEVERITY_ORDER.indexOf(row.severity)).toSorted((a, b) => a - b),
		)
	})

	it("does not call a repository that was never scanned clear", async () => {
		const { output, text } = await list(admin, {
			area: "dependencies",
			repository: "acme/api",
			status: "all",
		})
		expect(output.areas[0]).toMatchObject({ area: "dependencies", state: "not_scanned", matched: 0 })
		expect(text).toContain("acme/api has never had a dependency scan")
		const shop = await list(admin, { area: "dependencies", repository: "acme/shop" })
		expect(shop.output.areas[0]?.state).toBe("findings")
	})

	it("says a repository outside the audit is not set up rather than clear", async () => {
		const { output } = await list(admin, { area: "code", repository: "acme/unknown" })
		expect(output.areas[0]).toMatchObject({ area: "code", state: "not_connected" })
	})

	it("lists each repository's latest audit run and dependency scan in the overview", async () => {
		const { output } = await list(admin, {})
		expect(output.repositories).toEqual([
			expect.objectContaining({
				repository: "acme/shop",
				audit: expect.objectContaining({ lastRunId: "run-shop-1", lastRunStatus: "complete" }),
				dependencyScan: expect.objectContaining({ status: "completed" }),
			}),
			expect.objectContaining({
				repository: "acme/api",
				audit: expect.objectContaining({
					lastRunId: "run-api-1",
					lastRunStopReason: "org_spend_limit_reached",
				}),
				dependencyScan: expect.objectContaining({ status: null }),
			}),
		])
	})

	it("does not tell a member that an audited repository is not set up", async () => {
		const { output, text } = await list(member, {})
		expect(output.repositories?.find((r) => r.repository === "acme/shop")).toMatchObject({
			repository: "acme/shop",
			auditReadable: false,
			audit: null,
		})
		expect(text).toContain("admins and engineers only")
		expect(text).not.toContain("not set up")
	})

	it("keeps code findings from members, as the dashboard does", async () => {
		const { output } = await list(member, { area: "code" })
		expect(output.areas[0]).toMatchObject({ area: "code", state: "forbidden" })
		expect(output.findings).toEqual([])
	})

	it("does not report a catch-all service's answered probes as exposures", async () => {
		const { output } = await list(admin, { area: "exposure" })
		expect(Arr.map(output.findings, (row) => row.id)).toEqual([
			"legacy-admin:/.env",
			"billing:/actuator/env",
		])
		expect(Arr.join(output.notes, "\n")).toContain(SECURITY_WORLD.catchAllService)
		expect(output.exposure?.sources[0]).toMatchObject({ address: "185.220.101.4", scanner: "nuclei" })
	})

	it("does not place a dev dependency in production", async () => {
		const { output } = await list(admin, { area: "dependencies" })
		const vitest = output.findings.find((row) => Str.startsWith("vitest")(row.title))
		const next = output.findings.find((row) => Str.startsWith("next")(row.title))
		expect(vitest?.services).toEqual([])
		expect(next?.services).toEqual([{ service: "checkout", environment: "production" }])
	})

	it("narrows code findings to a service through the repository it runs", async () => {
		const { output } = await list(admin, { service: "checkout" })
		const areas = new Set(Arr.map(output.findings, (row) => row.area))
		expect(areas).toEqual(new Set(["code", "dependencies", "runtimes"]))
		expect(Arr.some(output.findings, (row) => row.id === SECURITY_WORLD.criticalFingerprint)).toBe(true)
	})

	it("shows triaged findings and why only when asked for them", async () => {
		const open = await list(admin, { area: "code" })
		expect(Arr.some(open.output.findings, (row) => row.status === "dismissed")).toBe(false)
		const all = await list(admin, { area: "code", status: "all" })
		const dismissed = all.output.findings.find((row) => row.status === "dismissed")
		expect(dismissed?.detail).toContain("single-use at the payment provider")
	})

	it("skips the per-service areas under a repository filter", async () => {
		const { output } = await list(admin, { repository: "acme/api" })
		expect(Arr.map(output.areas, (area) => area.area)).toEqual(["code", "dependencies"])
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
		const versions = Arr.flatMap(output.matches, (m) =>
			m.area === "runtimes" ? [[m.version, m.fixedIn]] : [],
		)
		expect(versions).toEqual(
			expect.arrayContaining([
				["18.19.0", "18.20.6"],
				["22.4.0", "22.12.0"],
			]),
		)
		const runtimes = output.coverage.find((line) => Str.startsWith("Runtimes:")(line))
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
				Str.includes(" AS commitSha")(sql) &&
				Str.includes(" AS spanCount")(sql) &&
				!Str.includes("lastSeen")(sql),
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
		expect(probe?.area === "exposure" ? Arr.map(probe.probes, (p) => p.signature) : []).toEqual([
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

describe("list_security_audit_runs", () => {
	const runs = async (rt: EvalRuntime, params: Record<string, unknown>) => {
		const result: McpToolResult = await runToolDirect(rt, "list_security_audit_runs", params)
		return {
			output: Schema.decodeUnknownSync(ListSecurityAuditRunsOutput)(result.structuredContent),
			text: markdown(result),
		}
	}

	it("lists runs newest first with why one stopped and the month's spend against the limit", async () => {
		const { output, text } = await runs(admin, {})
		expect(Arr.map(output.runs, (run) => run.runId)).toEqual(["run-shop-1", "run-api-1", "run-shop-0"])
		expect(output.runs[1]).toMatchObject({
			repository: "acme/api",
			status: "incomplete",
			stopReason: "org_spend_limit_reached",
			durationMinutes: 120,
		})
		expect(output.runs[0]?.findings).toMatchObject({ critical: 2, rejected: 1 })
		expect(output.spend.monthlyLimitUsd).toBe(25)
		expect(output.spend.spentUsd).toBeGreaterThanOrEqual(25)
		expect(text).toContain("reached its monthly audit spend limit")
	})

	it("narrows to one repository and hides what runs reported from members", async () => {
		const { output } = await runs(member, { repository: "ACME/shop" })
		expect(Arr.map(output.runs, (run) => run.runId)).toEqual(["run-shop-1", "run-shop-0"])
		expect(Arr.map(output.runs, (run) => run.findings)).toEqual([null, null])
	})

	it("names a repository that is not set up", async () => {
		const { output } = await runs(admin, { repository: "acme/unknown" })
		expect(output.runs).toEqual([])
		expect(Arr.join(output.notes, "\n")).toContain("acme/unknown is not set up")
	})
})

describe("inspect_security_audit_run", () => {
	const inspectRun = async (rt: EvalRuntime, params: Record<string, unknown>) => {
		const result: McpToolResult = await runToolDirect(rt, "inspect_security_audit_run", params)
		return result
	}
	const decode = (result: McpToolResult) =>
		Schema.decodeUnknownSync(InspectSecurityAuditRunOutput)(result.structuredContent)

	it("shows what a stopped run left unsettled, first, with its log", async () => {
		const output = decode(await inspectRun(admin, { repository: "acme/api" }))
		expect(output.run.runId).toBe("run-api-1")
		expect(Arr.map(output.coverage.units, (unit) => unit.status)).toEqual([
			"blocked",
			"deferred",
			"planned",
			"covered",
			"covered",
		])
		expect(output.coverage.units[0]?.unresolved).toContain("generated at build time")
		expect(Arr.join(output.notes, "\n")).toContain("3 of 5 coverage units not settled")
		expect(Arr.map(output.events, (event) => event.kind)).toEqual([
			"Phase",
			"Phase",
			"Agent",
			"Agent",
			"Note",
		])
	})

	it("lists rejected claims with the verifier's reason", async () => {
		const output = decode(await inspectRun(admin, { run_id: "run-shop-1" }))
		expect(output.findings[0]?.severity).toBe("critical")
		expect(output.findings.find((f) => f.fingerprint === "checkout/webhook-ssrf")).toMatchObject({
			verdict: "rejected",
			rejectedBecause: "callbackUrl is read from server config, never from the request.",
		})
	})

	it("refuses members, an unknown run and a call with no run", async () => {
		expect((await inspectRun(member, { run_id: "run-shop-1" })).isError).toBe(true)
		expect(markdown(await inspectRun(admin, { run_id: "run-nope" }))).toContain("No audit run run-nope")
		expect((await inspectRun(admin, {})).isError).toBe(true)
	})
})

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "informational", "unknown"]
