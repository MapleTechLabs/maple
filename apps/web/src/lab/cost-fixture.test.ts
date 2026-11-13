import { Array as Arr } from "effect"
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
		).toEqual(["aws", "cloudflare", "github", "planetscale"])

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

	test("Cloudflare is added waiting for its first sync, and a removed one takes its cost with it", () => {
		const cloudflare = (added: boolean | null, from = LAB_SOURCES.synced) => {
			const changes = { openRouter: null, cloudflare: added, planetScale: null, github: {} }
			return {
				sources: Arr.map(
					Arr.filter(
						labSourcesWith(from, changes).sources,
						(source) => source.provider === "cloudflare",
					),
					(source) => source.status,
				),
				costRemoved: Arr.contains(labRemovedProviders(changes), "cloudflare"),
			}
		}
		expect(cloudflare(null)).toEqual({ sources: ["ok"], costRemoved: false })
		expect(cloudflare(false)).toEqual({ sources: [], costRemoved: true })
		expect(cloudflare(true, LAB_SOURCES.none)).toEqual({ sources: ["pending"], costRemoved: false })
	})

	test("PlanetScale is added waiting for its first sync, and a removed one takes its cost with it", () => {
		const planetScale = (added: boolean | null, from = LAB_SOURCES.synced) => {
			const changes = { openRouter: null, cloudflare: null, planetScale: added, github: {} }
			return {
				sources: Arr.map(
					Arr.filter(
						labSourcesWith(from, changes).sources,
						(source) => source.provider === "planetscale",
					),
					(source) => source.status,
				),
				costRemoved: Arr.contains(labRemovedProviders(changes), "planetscale"),
			}
		}
		expect(planetScale(null)).toEqual({ sources: ["ok"], costRemoved: false })
		expect(planetScale(false)).toEqual({ sources: [], costRemoved: true })
		expect(planetScale(true, LAB_SOURCES.none)).toEqual({ sources: ["pending"], costRemoved: false })
	})

	test("a GitHub organization is added and removed on its own, and the other keeps its source and cost", () => {
		const github = (changes: Readonly<Record<string, boolean>>) => {
			const sources = labSourcesWith(LAB_SOURCES.synced, {
				openRouter: null,
				cloudflare: null,
				planetScale: null,
				github: changes,
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
						openRouter: null,
						cloudflare: null,
						planetScale: null,
						github: changes,
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
})
