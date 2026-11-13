import { Array as Arr } from "effect"
import { CredentialProvider } from "../page/cost/providers"
import { describe, expect, test } from "vitest"
import {
	LAB_SOURCES,
	labBreakdown,
	labGithubInstallations,
	labRemovedProviders,
	labSourcesWith,
	labTimeseries,
	labTotals,
} from "./cost-fixture"

const window = { days: 30, filters: undefined }
const openRouterOnly = { days: 30, filters: { provider: ["openrouter"] } }

describe("cost lab fixture", () => {
	test("a removed OpenRouter source leaves every read, also under a filter naming it", () => {
		const before = labTotals(window).cost
		const after = labTotals({ ...window, without: ["openrouter"] }).cost
		expect(after).toBeGreaterThan(0)
		expect(after).toBeLessThan(before)
		expect(
			Arr.map(
				labBreakdown({ ...window, without: ["openrouter"], groupBy: "provider", sortBy: "cost" })
					.rows,
				(row) => row.key,
			),
		).toEqual(["aws", "anthropic", "vercel", "openai", "cloudflare", "github", "planetscale"])

		// Filtered to OpenRouter there is nothing left: AWS cost must not show under that filter.
		expect(labTotals(openRouterOnly).cost).toBeGreaterThan(0)
		expect(labTotals({ ...openRouterOnly, without: ["openrouter"] }).cost).toBe(0)
		expect(
			labBreakdown({
				...openRouterOnly,
				without: ["openrouter"],
				groupBy: "cloud_service",
				sortBy: "cost",
			}).rows,
		).toEqual([])
		expect(
			labTimeseries({ ...openRouterOnly, without: ["openrouter"], groupBy: "provider", limit: 8 })
				.series,
		).toEqual([])
	})

	test.each(CredentialProvider.literals)(
		"%s is added waiting for its first sync, and a removed one takes its cost with it",
		(provider) => {
			const outcome = (added: boolean | null, from = LAB_SOURCES.synced) => {
				const changes = {
					credentials: added === null ? {} : { [provider]: added },
					github: {},
					vercel: null,
					planetScale: null,
				}
				return {
					sources: Arr.map(
						Arr.filter(
							labSourcesWith(from, changes).sources,
							(source) => source.provider === provider,
						),
						(source) => source.status,
					),
					costRemoved: Arr.contains(labRemovedProviders(changes), provider),
				}
			}
			expect(outcome(null)).toEqual({ sources: ["ok"], costRemoved: false })
			expect(outcome(false)).toEqual({ sources: [], costRemoved: true })
			expect(outcome(true, LAB_SOURCES.none)).toEqual({ sources: ["pending"], costRemoved: false })
		},
	)

	test("a GitHub organization is added and removed on its own, and the other keeps its source and cost", () => {
		const github = (changes: Readonly<Record<string, boolean>>) => {
			const sources = labSourcesWith(LAB_SOURCES.synced, {
				credentials: {},
				github: changes,
				vercel: null,
				planetScale: null,
			})
			return {
				sources: Arr.map(
					Arr.filter(sources.sources, (source) => source.provider === "github"),
					(source) => `${source.accountId} ${source.status}`,
				),
				listed: Arr.map(
					labGithubInstallations(sources).installations,
					(installation) => `${installation.accountLogin} ${installation.state}`,
				),
				costRemoved: Arr.contains(
					labRemovedProviders({
						credentials: {},
						github: changes,
						vercel: null,
						planetScale: null,
					}),
					"github",
				),
			}
		}
		const ids = Arr.map(
			labGithubInstallations(LAB_SOURCES.synced).installations,
			(installation) => installation.installationId,
		)
		const org = ids[0] ?? ""
		const labs = ids[1] ?? ""
		expect([org, labs]).not.toContain("")

		// The second organization added: it waits for its first sync beside the first.
		expect(github({ [labs]: true })).toMatchObject({
			sources: ["example-org ok", "example-labs pending"],
			costRemoved: false,
		})
		// Removed again: the first organization's source and cost are untouched.
		expect(github({ [labs]: false })).toMatchObject({
			sources: ["example-org ok"],
			listed: expect.arrayContaining(["example-org added", "example-labs available"]),
			costRemoved: false,
		})
		// The first organization removed takes its cost with it, and added back it waits for a sync.
		expect(github({ [org]: false })).toMatchObject({
			sources: [],
			listed: expect.arrayContaining(["example-org available"]),
			costRemoved: true,
		})
		expect(github({ [org]: true })).toMatchObject({ sources: ["example-org pending"], costRemoved: true })
	})
	test("a removed Vercel source leaves every read too, and the other providers stay", () => {
		expect(labTotals({ ...window, without: ["vercel"] }).cost).toBeLessThan(labTotals(window).cost)
		expect(
			Arr.map(
				labBreakdown({ ...window, without: ["vercel"], groupBy: "provider", sortBy: "cost" }).rows,
				(row) => row.key,
			),
		).toEqual(["aws", "openrouter", "anthropic", "openai", "cloudflare", "github", "planetscale"])
		expect(labTotals({ days: 30, filters: { provider: ["vercel"] }, without: ["vercel"] }).cost).toBe(0)
	})

	test("a Vercel source added again after its removal is a new one that waits for its first sync", () => {
		const after = (vercel: boolean | null) => {
			const changes = { credentials: {}, github: {}, vercel, planetScale: null }
			const sources = labSourcesWith(LAB_SOURCES.synced, changes)
			return {
				vercel: Arr.map(
					Arr.filter(sources.sources, (source) => source.provider === "vercel"),
					(source) => `${source.accountName} ${source.status}`,
				),
				others: Arr.filter(sources.sources, (source) => source.provider !== "vercel").length,
				costRemoved: Arr.contains(labRemovedProviders(changes), "vercel"),
			}
		}
		const others = LAB_SOURCES.synced.sources.length - 1
		expect(after(null)).toEqual({ vercel: ["example-team ok"], others, costRemoved: false })
		expect(after(false)).toEqual({ vercel: [], others, costRemoved: true })
		// Not the synced row it started with, and no cost until a sync the lab does not model.
		expect(after(true)).toEqual({ vercel: ["example-team pending"], others, costRemoved: true })
	})

	test("a PlanetScale source added again after its removal is a new one that waits for its first sync", () => {
		const after = (planetScale: boolean | null) => {
			const changes = { credentials: {}, github: {}, vercel: null, planetScale }
			const sources = labSourcesWith(LAB_SOURCES.synced, changes)
			return {
				planetScale: Arr.map(
					Arr.filter(sources.sources, (source) => source.provider === "planetscale"),
					(source) => `${source.accountId} ${source.status}`,
				),
				others: Arr.filter(sources.sources, (source) => source.provider !== "planetscale").length,
				costRemoved: Arr.contains(labRemovedProviders(changes), "planetscale"),
			}
		}
		const others = LAB_SOURCES.synced.sources.length - 1
		expect(after(null)).toEqual({ planetScale: ["example-data ok"], others, costRemoved: false })
		expect(after(false)).toEqual({ planetScale: [], others, costRemoved: true })
		expect(after(true)).toEqual({ planetScale: ["example-data pending"], others, costRemoved: true })
		// Its cost leaves every read with it, also under a filter naming it.
		expect(labTotals({ ...window, without: ["planetscale"] }).cost).toBeLessThan(labTotals(window).cost)
		expect(
			labTotals({ days: 30, filters: { provider: ["planetscale"] }, without: ["planetscale"] }).cost,
		).toBe(0)
	})

	test("grouped by resource, cost splits by GitHub repository, Vercel project, PlanetScale branch, Anthropic workspace and OpenAI project, and the rest has none", () => {
		expect(
			Arr.map(labBreakdown({ ...window, groupBy: "resource", sortBy: "cost" }).rows, (row) => row.key),
		).toEqual([
			"",
			"wrkspc_example_agents",
			"proj_ExampleSupport",
			"example-web",
			"example-orders/main",
			"example-api",
			"example-docs",
			"default",
			"example-search/main",
			"example-orders/staging",
			"proj_ExampleSearch",
			"example-site",
		])
		// Narrowed to a provider, only its own resources are left.
		expect(
			Arr.map(
				labBreakdown({
					days: 30,
					filters: { provider: ["github"] },
					groupBy: "resource",
					sortBy: "cost",
				}).rows,
				(row) => row.key,
			),
		).toEqual(["example-api", "", "example-site"])
		// A branch carries its database, so the two `main` branches stay apart.
		expect(
			Arr.map(
				labBreakdown({
					days: 30,
					filters: { provider: ["planetscale"] },
					groupBy: "resource",
					sortBy: "cost",
				}).rows,
				(row) => row.key,
			),
		).toEqual(["example-orders/main", "example-search/main", "example-orders/staging"])
	})
})
