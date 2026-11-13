import { CostSourceSummary } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { drilledInto, facetFilters, keyLabel, onlyFilter, toggledFilter } from "./derive"
import { keyDetail, keyMark } from "./marks"

const source = (
	provider: CostSourceSummary["provider"],
	accountId: string,
	id = "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e1f",
): CostSourceSummary =>
	Schema.decodeSync(CostSourceSummary)({
		id,
		provider,
		connectionRef: id,
		accountId,
		status: "ok",
		watermarkDate: "2026-11-10",
		backfillDate: "2026-01-01",
		historyComplete: true,
		lastSyncedAt: null,
		lastError: null,
		lastErrorReason: null,
		requestsThisMonth: 0,
	})

const sources = [source("aws", "465760687006"), source("openrouter", "user_2zZ0ZRlIh83bwUonpAHz1xTcuG6")]

describe("cost key marks", () => {
	test("an account reads as the provider that bills it, an OpenRouter one by name with its id aside", () => {
		expect(keyLabel("account", "465760687006", sources)).toBe("AWS 465760687006")
		expect(keyLabel("account", "user_2zZ0ZRlIh83bwUonpAHz1xTcuG6", sources)).toBe("OpenRouter")
		expect(keyDetail("account", "user_2zZ0ZRlIh83bwUonpAHz1xTcuG6", sources)).toBe(
			"user_2zZ0ZRlIh83bwUonpAHz1xTcuG6",
		)
		expect(keyMark("account", "465760687006", sources)?.icon).toBe(keyMark("provider", "aws", [])?.icon)
		expect(keyMark("account", "user_2zZ0ZRlIh83bwUonpAHz1xTcuG6", sources)?.icon).toBe(
			keyMark("provider", "openrouter", [])?.icon,
		)
	})

	test("two OpenRouter accounts keep their ids so their series stay apart", () => {
		const two = [...sources, source("openrouter", "org_second", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e20")]
		expect(keyLabel("account", "org_second", two)).toBe("OpenRouter org_second")
	})

	test("an AWS service wears the AWS mark, an OpenRouter model its vendor's", () => {
		const aws = keyMark("provider", "aws", [])?.icon
		expect(keyMark("cloud_service", "Amazon Elastic Compute Cloud - Compute", [])?.icon).toBe(aws)
		expect(keyMark("region", "eu-west-1", [])?.icon).toBe(aws)
		expect(keyMark("cloud_service", "openai/gpt-5", [])?.icon).not.toBe(aws)
		expect(keyMark("cloud_service", "", [])).toBeNull()
	})

	test("a Cloudflare product wears the Cloudflare mark, also beside an AWS source", () => {
		const cloudflare = keyMark("provider", "cloudflare", [])?.icon
		const both = [...sources, source("cloudflare", "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d")]
		expect(keyMark("cloud_service", "Workers", both)?.icon).toBe(cloudflare)
		expect(keyMark("cloud_service", "Durable Objects", [])?.icon).toBe(cloudflare)
		// Plan fees are filed under one service name.
		expect(keyMark("cloud_service", "Subscriptions", both)?.icon).toBe(cloudflare)
		// An AWS service beside it keeps the AWS mark.
		expect(keyMark("cloud_service", "Amazon Simple Storage Service", both)?.icon).toBe(
			keyMark("provider", "aws", [])?.icon,
		)
		// A product Maple has no name for is Cloudflare's when no AWS source could bill it.
		const alone = [source("cloudflare", "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d")]
		expect(keyMark("cloud_service", "Something New", alone)?.icon).toBe(cloudflare)
	})

	test("a Cloudflare account reads by name with its id aside, and bills in no region of its own", () => {
		const account = "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d"
		const both = [...sources, source("cloudflare", account)]
		expect(keyLabel("account", account, both)).toBe("Cloudflare")
		expect(keyDetail("account", account, both)).toBe(account)
		expect(keyMark("account", account, both)?.icon).toBe(keyMark("provider", "cloudflare", [])?.icon)
		// An AWS account's id is already in its name.
		expect(keyDetail("account", "465760687006", both)).toBeNull()
		expect(keyMark("region", "global", both)?.icon).not.toBe(keyMark("provider", "aws", [])?.icon)
	})

	test("a GitHub account reads by its organization, with nothing beside it, and wears GitHub's mark", () => {
		const github = keyMark("provider", "github", [])?.icon
		const withGithub = [
			...sources,
			source("github", "example-org", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21"),
		]
		expect(keyLabel("account", "example-org", withGithub)).toBe("GitHub example-org")
		expect(keyDetail("account", "example-org", withGithub)).toBeNull()
		expect(keyMark("account", "example-org", withGithub)?.icon).toBe(github)
		// A second organization reads the same way: the name already tells them apart.
		const two = [...withGithub, source("github", "example-labs", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e22")]
		expect(keyLabel("account", "example-labs", two)).toBe("GitHub example-labs")
	})

	test("a GitHub product wears GitHub's mark, also beside AWS services; its category a glyph", () => {
		const aws = keyMark("provider", "aws", [])?.icon
		const github = keyMark("provider", "github", [])?.icon
		const both = [...sources, source("github", "example-org", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21")]
		expect(keyMark("cloud_service", "Actions", both)?.icon).toBe(github)
		expect(keyMark("cloud_service", "Git LFS", [])?.icon).toBe(github)
		expect(keyMark("cloud_service", "Amazon Simple Storage Service", both)?.icon).toBe(aws)
		// A product GitHub starts billing later: GitHub's when no AWS account could bill it.
		const githubOnly = [source("github", "example-org"), source("openrouter", "user_one")]
		expect(keyMark("cloud_service", "Models", githubOnly)?.icon).toBe(github)
		// Beside AWS either could bill it: no logo is better than a wrong one.
		expect(keyMark("cloud_service", "Models", both)?.icon).toBe("CubeIcon")
		expect(keyMark("service_category", "Developer Tools", [])?.icon).toBe("CodeIcon")
		// GitHub bills no region: its rows are `global`, which is the globe and not a logo.
		expect(keyMark("region", "global", both)?.icon).toBe("GlobeIcon")
	})

	test("with AWS, GitHub and Cloudflare in one org, each key wears the mark of the one that bills it", () => {
		const all = [
			...sources,
			source("github", "example-org", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21"),
			source("cloudflare", "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e23"),
		]
		const markOf = (provider: string) => keyMark("provider", provider, [])?.icon
		expect(keyMark("cloud_service", "Workers", all)?.icon).toBe(markOf("cloudflare"))
		expect(keyMark("cloud_service", "Actions", all)?.icon).toBe(markOf("github"))
		expect(keyMark("cloud_service", "Amazon Simple Storage Service", all)?.icon).toBe(markOf("aws"))
		expect(keyMark("cloud_service", "AWS Key Management Service", all)?.icon).toBe(markOf("aws"))
		expect(keyMark("cloud_service", "Elastic Load Balancing", all)?.icon).toBe(markOf("aws"))
		// A name none of the three is known by gets the service glyph, never a guessed logo.
		expect(keyMark("cloud_service", "Something New", all)?.icon).toBe("CubeIcon")
		// Only AWS bills by region: a region that is not `global` is AWS's, also an unlisted one.
		expect(keyMark("region", "mx-central-1", all)?.icon).toBe(markOf("aws"))
		expect(keyMark("region", "global", all)?.icon).toBe("GlobeIcon")
		// Without an AWS source a region that is no AWS code is nobody's.
		const noAws = [source("cloudflare", "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d")]
		expect(keyMark("region", "somewhere", noAws)?.icon).toBe("GlobeIcon")
		// Each account wears its own provider's mark.
		expect(keyMark("account", "example-org", all)?.icon).toBe(markOf("github"))
		expect(keyMark("account", "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d", all)?.icon).toBe(markOf("cloudflare"))
		expect(keyMark("account", "465760687006", all)?.icon).toBe(markOf("aws"))
	})

	test("a PlanetScale account reads by its organization, and its databases wear its mark", () => {
		const withPlanetScale = [
			...sources,
			source("planetscale", "acme", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21"),
		]
		const planetScale = keyMark("provider", "planetscale", [])?.icon
		// The organization is a name its reader knows: it stays in the label, with nothing aside.
		expect(keyLabel("account", "acme", withPlanetScale)).toBe("PlanetScale acme")
		expect(keyDetail("account", "acme", withPlanetScale)).toBeNull()
		expect(keyMark("account", "acme", withPlanetScale)?.icon).toBe(planetScale)
		// A database is the service. Its name is lowercase, where every other platform's has a capital or a space.
		expect(keyMark("cloud_service", "orders-prod", withPlanetScale)?.icon).toBe(planetScale)
		expect(keyMark("cloud_service", "Amazon Relational Database Service", withPlanetScale)?.icon).toBe(
			keyMark("provider", "aws", [])?.icon,
		)
		expect(keyMark("cloud_service", "openai/gpt-5", withPlanetScale)?.icon).not.toBe(planetScale)
		// A charge that names no database is PlanetScale's where the org reads no other platform.
		const onlyPlanetScale = [source("planetscale", "acme", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21")]
		expect(keyMark("cloud_service", "Support plan", onlyPlanetScale)?.icon).toBe(planetScale)
		// Without a PlanetScale source a lowercase name is no database of its.
		expect(keyMark("cloud_service", "orders-prod", sources)?.icon).not.toBe(planetScale)
		// Its charges have no region: the one it carries is the globe every provider's `global` gets.
		expect(keyMark("region", "global", withPlanetScale)?.icon).toBe(keyMark("region", "global", [])?.icon)
	})

	test("with AWS, GitHub and PlanetScale in one org, a database's shape claims no other platform's key", () => {
		const org = [
			source("aws", "465760687006"),
			source("github", "example-org", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e22"),
			source("planetscale", "acme", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21"),
		]
		const markOf = (key: string) => keyMark("cloud_service", key, org)?.icon
		expect(markOf("orders-prod")).toBe(keyMark("provider", "planetscale", [])?.icon)
		// The names every platform is known by come first.
		expect(markOf("Actions")).toBe(keyMark("provider", "github", [])?.icon)
		expect(markOf("Amazon Simple Storage Service")).toBe(keyMark("provider", "aws", [])?.icon)
		expect(markOf("Workers")).toBe(keyMark("provider", "cloudflare", [])?.icon)
		// A PlanetScale charge with no database and no description is filed under the provider's name.
		expect(markOf("PlanetScale")).toBe(keyMark("provider", "planetscale", [])?.icon)
		// A charge no name or shape places, in an org three platforms could bill: a glyph, no logo.
		expect(markOf("Support plan")).toBe("CubeIcon")
		expect(keyLabel("account", "acme", org)).toBe("PlanetScale acme")
		expect(keyLabel("account", "example-org", org)).toBe("GitHub example-org")
	})

	test("a PlanetScale row filters and drills like any other: provider to its databases, a database on", () => {
		expect(drilledInto({ groupBy: "provider" }, { dimension: "provider", value: "planetscale" })).toEqual(
			{
				groupBy: "cloud_service",
				provider: ["planetscale"],
			},
		)
		expect(
			facetFilters({ provider: ["planetscale"], cloud_service: ["orders-prod"] }, "account"),
		).toEqual({
			provider: ["planetscale"],
			cloud_service: ["orders-prod"],
		})
	})

	test("a GitHub row drills like any other: a provider to its services, a service to its accounts", () => {
		expect(drilledInto({ groupBy: "provider" }, { dimension: "provider", value: "github" })).toEqual({
			groupBy: "cloud_service",
			provider: ["github"],
		})
		expect(
			drilledInto(
				{ groupBy: "cloud_service", provider: ["github"], region: ["global"] },
				{ dimension: "cloud_service", value: "Actions" },
			),
		).toMatchObject({ groupBy: "account", cloud_service: ["Actions"] })
		expect(facetFilters({ provider: ["github"], account: ["example-org"] }, "account")).toEqual({
			provider: ["github"],
		})
	})

	test("an AWS region says where it is; an unknown one adds nothing", () => {
		expect(keyDetail("region", "eu-central-1", [])).toBe("Frankfurt")
		expect(keyDetail("region", "mars-north-1", [])).toBeNull()
	})
})

describe("cost filter rail", () => {
	test("a facet reads under every filter but its own, so its other values stay on offer", () => {
		const search = { provider: ["aws"], region: ["eu-west-1"] }
		expect(facetFilters(search, "provider")).toEqual({ region: ["eu-west-1"] })
		expect(facetFilters(search, "cloud_service")).toEqual({ provider: ["aws"], region: ["eu-west-1"] })
	})

	test("a checkbox adds the value or takes it out; Only leaves it alone in its dimension", () => {
		const search = { provider: ["aws"] }
		expect(toggledFilter(search, { dimension: "provider", value: "openrouter" }).provider).toEqual([
			"aws",
			"openrouter",
		])
		expect(toggledFilter(search, { dimension: "provider", value: "aws" }).provider).toBeUndefined()
		expect(
			onlyFilter({ provider: ["aws", "openrouter"] }, { dimension: "provider", value: "openrouter" })
				.provider,
		).toEqual(["openrouter"])
	})
})
