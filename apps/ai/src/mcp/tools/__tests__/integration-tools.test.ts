import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	CiRunsOutput,
	CompareCommitsOutput,
	ListIntegrationsOutput,
	ListSourcesOutput,
	ScrapeTargetMutationOutput,
} from "@maple/domain/mcp-outputs"
import { RoleName } from "@maple/domain/primitives"
import type { McpToolResult } from "../types"
import { installFakeWarehouse, restoreWarehouse } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import {
	CI_WORLD,
	INTEGRATION_WORLD,
	integrationFixtureRules,
	seedCommitWorld,
	seedIntegrationWorld,
} from "../../__evals__/integration-world"
import { providerFixtureRules } from "../../__evals__/provider-world"

let member: EvalRuntime
let admin: EvalRuntime
beforeAll(async () => {
	installFakeWarehouse([...integrationFixtureRules(), ...providerFixtureRules()], undefined, "empty")
	member = makeEvalRuntime()
	await seedIntegrationWorld(member)
	await seedCommitWorld(member)
	// Same database, an org admin calling.
	admin = { ...member, tenant: { ...member.tenant, roles: [Schema.decodeSync(RoleName)("org:admin")] } }
})
afterAll(async () => {
	restoreWarehouse()
	await member.dispose()
})

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, result: McpToolResult) =>
	Schema.decodeUnknownSync(schema)(result.structuredContent)

describe("list_integrations", () => {
	it("names every broken resource in one call, with unhealthy of total per provider", async () => {
		const result = await runToolDirect(member, "list_integrations", {})
		const output = decode(ListIntegrationsOutput, result)
		const byProvider = new Map(output.integrations.map((i) => [i.provider, i]))
		expect(byProvider.get("github")?.resources.map((r) => r.name)).toEqual([INTEGRATION_WORLD.brokenRepo])
		expect(byProvider.get("railway")?.status).toBe("stale")
		expect(byProvider.get("railway")?.unhealthyCount).toBe(1)
		expect(byProvider.get("prometheus")?.resources.map((r) => r.name)).toEqual([
			INTEGRATION_WORLD.failingScrapeTarget,
		])
		expect(output.available.map((a) => a.provider)).toEqual(["chat"])
		expect(markdown(result)).toContain("no successful update for 4 h")
	})

	it("never shows a scrape URL's token", async () => {
		const result = await runToolDirect(member, "list_integrations", { provider: "prometheus" })
		expect(markdown(result)).not.toContain("fixture-secret")
		expect(JSON.stringify(result.structuredContent)).not.toContain("fixture-secret")
	})
})

describe("list_sources", () => {
	it("lists every integration as a source, worst health first, beside the default source", async () => {
		const result = await runToolDirect(member, "list_sources", {})
		const output = decode(ListSourcesOutput, result)
		const byName = new Map(output.sources.map((s) => [s.name, s]))
		expect(byName.get(INTEGRATION_WORLD.failingScrapeTarget)).toMatchObject({
			platform: "prometheus",
			kind: "integration",
			status: "failing",
		})
		expect(output.sources.find((s) => s.platform === "railway")?.status).toBe("stale")
		expect(output.sources.find((s) => s.kind === "default")).toMatchObject({ status: "pending" })
		expect(output.sources.every((s) => s.id.startsWith("src_"))).toBe(true)
		expect(output.sources[0]?.status).toBe("failing")
		expect(JSON.stringify(result.structuredContent)).not.toContain("fixture-secret")
	})

	it("keeps source ids stable across calls", async () => {
		const ids = async () =>
			decode(ListSourcesOutput, await runToolDirect(member, "list_sources", {}))
				.sources.map((s) => s.id)
				.sort()
		expect(await ids()).toEqual(await ids())
	})
})

describe("ci_runs", () => {
	it("names the commit a red streak started on and hands compare_commits both full SHAs", async () => {
		const result = await runToolDirect(member, "ci_runs", { repository: "shop" })
		const ci = decode(CiRunsOutput, result).pipelines.find((p) => p.pipeline === "CI")
		expect(ci?.red).toMatchObject({
			failedRuns: 3,
			firstFailedRevision: CI_WORLD.couponCommit,
			lastGreenRevision: CI_WORLD.base,
		})
		expect(markdown(result)).toContain(
			`compare_commits base="${CI_WORLD.base}" head="${CI_WORLD.couponCommit}"`,
		)
	})

	it("still finds the last green commit when only failures are listed", async () => {
		const result = await runToolDirect(member, "ci_runs", { repository: "shop", result: "failure" })
		const output = decode(CiRunsOutput, result)
		expect(output.runs.every((run) => run.result === "failure")).toBe(true)
		expect(output.runs[0]?.failedJobs[0]?.job).toBe(CI_WORLD.failingJob)
		expect(output.pipelines.find((p) => p.pipeline === "CI")?.red?.lastGreenRevision).toBe(CI_WORLD.base)
	})

	it("says how many runs matched the result filter when the limit cut some off", async () => {
		const result = await runToolDirect(member, "ci_runs", {
			repository: "shop",
			result: "failure",
			limit: 1,
		})
		const output = decode(CiRunsOutput, result)
		expect(output.runs).toHaveLength(1)
		expect(output.runsMatched).toBe(3)
		expect(markdown(result)).toContain("1 of 3 runs")
	})

	it("keeps the workflow summary when the result filter matches no run", async () => {
		const result = await runToolDirect(member, "ci_runs", { repository: "shop", result: "cancellation" })
		const output = decode(CiRunsOutput, result)
		expect(output.runs).toEqual([])
		expect(output.pipelines.map((p) => p.pipeline).sort()).toEqual(["CI", "Deploy"])
		const text = markdown(result)
		expect(text).toContain("No run in this window matched `result=cancellation`")
		expect(text).not.toContain("No CI workflow runs in this window")
	})
})

describe("compare_commits", () => {
	it("lists what a service's latest deploy shipped", async () => {
		const result = await runToolDirect(member, "compare_commits", { service: "checkout" })
		const output = decode(CompareCommitsOutput, result)
		expect(output.status).toBe("resolved")
		expect(output.commits.map((c) => c.sha)).toEqual([
			CI_WORLD.head,
			CI_WORLD.retryCommit,
			CI_WORLD.couponCommit,
		])
	})

	it("narrows to the one commit between a last green and first red run", async () => {
		const result = await runToolDirect(member, "compare_commits", {
			base: CI_WORLD.base,
			head: CI_WORLD.couponCommit,
		})
		expect(decode(CompareCommitsOutput, result).commits.map((c) => c.title)).toEqual([
			"feat(cart): allow stacking two coupons",
		])
	})

	it("refuses a short SHA and says where full ones come from", async () => {
		const result = await runToolDirect(member, "compare_commits", {
			base: CI_WORLD.base.slice(0, 12),
			head: CI_WORLD.head,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("full 40-character commit SHA")
	})
})

describe("update_scrape_target", () => {
	it("is refused for a member who is not an org admin", async () => {
		const result = await runToolDirect(member, "update_scrape_target", {
			target: INTEGRATION_WORLD.failingScrapeTarget,
			enabled: false,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("only org admins")
	})

	it("pauses a target for an admin and says it is paused", async () => {
		const result = await runToolDirect(admin, "update_scrape_target", {
			target: INTEGRATION_WORLD.failingScrapeTarget,
			enabled: false,
		})
		expect(decode(ScrapeTargetMutationOutput, result).target.enabled).toBe(false)
		expect(markdown(result)).toContain("Scraping is paused")
	})

	it("returns a target's URL without its token", async () => {
		const result = await runToolDirect(admin, "update_scrape_target", {
			target: "node-exporter",
			interval_seconds: 30,
		})
		expect(decode(ScrapeTargetMutationOutput, result).target.url).toBe("https://metrics.acme.dev/node")
		expect(markdown(result)).not.toContain("fixture-secret")
	})

	it("will not touch a target an integration manages", async () => {
		const result = await runToolDirect(admin, "update_scrape_target", {
			target: "PlanetScale acme",
			enabled: false,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("managed by the planetscale integration")
	})
})
