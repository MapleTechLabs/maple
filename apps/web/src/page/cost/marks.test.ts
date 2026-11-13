import { CostSourceSummary } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import {
	type ActiveFilter,
	drilledInto,
	facetFilters,
	keyLabel,
	onlyFilter,
	perDimension,
	toggledFilter,
	unsplitDimensions,
} from "./derive"
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

	test("a Cloudflare account reads by its account's name, and by the provider alone without one", () => {
		const account = "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d"
		const named = [
			...sources,
			Schema.decodeSync(CostSourceSummary)({
				...Schema.encodeSync(CostSourceSummary)(source("cloudflare", account)),
				accountName: "Example Account",
			}),
		]
		expect(keyLabel("account", account, named)).toBe("Cloudflare Example Account")
		expect(keyMark("account", account, named)?.icon).toBe(keyMark("provider", "cloudflare", [])?.icon)
		// A source read before its name was known reads by the provider: the id says nothing.
		const unnamed = [...sources, source("cloudflare", account)]
		expect(keyLabel("account", account, unnamed)).toBe("Cloudflare")
		// Cloudflare bills in no region of its own: its rows are `global`, the globe and not a logo.
		expect(keyMark("region", "global", named)?.icon).toBe("GlobeIcon")
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
		// Beside an AWS account its name says neither: a neutral glyph, never a logo that is a guess.
		const unknown = keyMark("cloud_service", "Models", both)?.icon
		expect([unknown === aws, unknown === github]).toEqual([false, false])
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
		// A region AWS lists is AWS's. One nobody is known by is the globe, with several platforms.
		expect(keyMark("region", "eu-west-1", all)?.icon).toBe(markOf("aws"))
		expect(keyMark("region", "somewhere", all)?.icon).toBe("GlobeIcon")
		expect(keyMark("region", "global", all)?.icon).toBe("GlobeIcon")
		// Each account wears its own provider's mark.
		expect(keyMark("account", "example-org", all)?.icon).toBe(markOf("github"))
		expect(keyMark("account", "1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d", all)?.icon).toBe(markOf("cloudflare"))
		expect(keyMark("account", "465760687006", all)?.icon).toBe(markOf("aws"))
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

	test("a Vercel account reads as the team it is, with the Vercel mark and nothing aside", () => {
		// The account is the team's id, which a rename leaves alone; the slug is how it is known.
		const team = source("vercel", "team_1", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21")
		const vercel = [...sources, { ...team, accountName: "acme" }]
		expect(keyLabel("account", "team_1", vercel)).toBe("Vercel acme")
		expect(keyDetail("account", "team_1", vercel)).toBeNull()
		expect(keyMark("account", "team_1", vercel)?.icon).toBe(keyMark("provider", "vercel", [])?.icon)
		expect(keyLabel("provider", "vercel")).toBe("Vercel")
		// A team whose name was not read is still Vercel's, never a bare team id.
		expect(keyLabel("account", "team_1", [...sources, team])).toBe("Vercel")
	})

	test("a service and a region wear the mark of the only platform that could have billed them", () => {
		const aws = keyMark("provider", "aws", [])?.icon
		const vercel = keyMark("provider", "vercel", [])?.icon
		const team = source("vercel", "acme", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21")
		// Vercel beside OpenRouter, whose services are model slugs: every other service is Vercel's.
		const vercelOnly = [team, source("openrouter", "user_2zZ0ZRlIh83bwUonpAHz1xTcuG6")]
		expect(keyMark("cloud_service", "Function Duration", vercelOnly)?.icon).toBe(vercel)
		expect(keyMark("region", "iad1", vercelOnly)?.icon).toBe(vercel)
		expect(keyMark("cloud_service", "openai/gpt-5", vercelOnly)?.icon).not.toBe(vercel)

		// With AWS too, a name says whose it is or it wears neither logo: never the wrong one.
		const both = [source("aws", "465760687006"), team]
		expect(keyMark("cloud_service", "Amazon Simple Storage Service", both)?.icon).toBe(aws)
		expect(keyMark("cloud_service", "AWS Lambda", both)?.icon).not.toBe(vercel)
		const unnamed = keyMark("cloud_service", "Function Duration", both)?.icon
		expect([unnamed === aws, unnamed === vercel]).toEqual([false, false])
		expect(keyMark("region", "eu-west-1", both)?.icon).toBe(aws)
		expect(keyMark("region", "fra1", both)?.icon).toBe(vercel)
		// An airport code is Vercel's only for an org that reads Vercel.
		expect(keyMark("region", "fra1", sources)?.icon).toBe(aws)
		expect(keyMark("region", "global", both)?.icon).toBe(keyMark("region", "global", [])?.icon)
	})

	test("an org with AWS, GitHub and Vercel: each key wears its own platform's mark, or none", () => {
		const aws = keyMark("provider", "aws", [])?.icon
		const github = keyMark("provider", "github", [])?.icon
		const vercel = keyMark("provider", "vercel", [])?.icon
		const all = [
			source("aws", "465760687006"),
			source("github", "example-org", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21"),
			{ ...source("vercel", "team_1", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e22"), accountName: "acme" },
		]
		// Services: a name that says whose it is, else no logo.
		expect(keyMark("cloud_service", "Amazon Simple Storage Service", all)?.icon).toBe(aws)
		expect(keyMark("cloud_service", "Actions", all)?.icon).toBe(github)
		const unnamed = keyMark("cloud_service", "Function Duration", all)?.icon
		expect([unnamed === aws, unnamed === github, unnamed === vercel]).toEqual([false, false, false])
		// Regions: AWS's codes, Vercel's ids, and the globe for what bills none.
		expect(keyMark("region", "eu-west-1", all)?.icon).toBe(aws)
		expect(keyMark("region", "iad1", all)?.icon).toBe(vercel)
		expect(keyMark("region", "global", all)?.icon).toBe("GlobeIcon")
		const elsewhere = keyMark("region", "north-1", all)?.icon
		expect([elsewhere === aws, elsewhere === vercel]).toEqual([false, false])
		// Accounts read as what they are.
		expect([
			keyLabel("account", "465760687006", all),
			keyLabel("account", "example-org", all),
			keyLabel("account", "team_1", all),
		]).toEqual(["AWS 465760687006", "GitHub example-org", "Vercel acme"])
		expect(keyMark("account", "example-org", all)?.icon).toBe(github)
		expect(keyMark("account", "team_1", all)?.icon).toBe(vercel)
	})

	test("a resource is a GitHub repository or a Vercel project: it reads by its name under one glyph", () => {
		const sources = [source("github", "example-org"), source("vercel", "team_1")]
		// The key does not say who bills it, so a repository and a project wear the same mark.
		const repository = keyMark("resource", "example-api", sources)
		expect(repository?.icon).toBe("FolderIcon")
		expect(keyMark("resource", "web", sources)).toEqual(repository)
		expect(keyLabel("resource", "example-api", sources)).toBe("example-api")
		expect(keyDetail("resource", "example-api", sources)).toBeNull()
		// A seat product names no repository, a plan fee no project.
		expect(keyLabel("resource", "", sources)).toBe("No resource")
		expect(keyMark("resource", "", sources)).toBeNull()
	})

	test("a resource wears its own glyph, since its key does not say who bills it", () => {
		const both = [source("aws", "465760687006"), source("vercel", "acme")]
		const mark = keyMark("resource", "web", both)?.icon
		expect(mark).toBeDefined()
		expect([
			mark === keyMark("provider", "aws", [])?.icon,
			mark === keyMark("provider", "vercel", [])?.icon,
		]).toEqual([false, false])
		expect(keyMark("resource", "", both)).toBeNull()
		expect(keyLabel("resource", "", both)).toBe("No resource")
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

	test("resources are a dimension of their own in the rail's reads", () => {
		const search = { provider: ["vercel"], resource: ["web"] }
		expect(facetFilters(search, "resource")).toEqual({ provider: ["vercel"] })
		expect(facetFilters(search, "cloud_service")).toEqual({ provider: ["vercel"], resource: ["web"] })
	})

	test("a drill-down reaches resources after regions, and passes over them where no cost has one", () => {
		const row = (key: string) => ({ key })
		const withProjects = unsplitDimensions(
			perDimension((dimension) => (dimension === "resource" ? [row(""), row("web")] : [row("x")])),
		)
		// Only charges with no resource: nothing to split by.
		const without = unsplitDimensions(
			perDimension((dimension) => (dimension === "resource" ? [row("")] : [row("x")])),
		)
		expect([withProjects, without, unsplitDimensions(undefined)]).toEqual([
			[],
			["resource"],
			["resource"],
		])

		const service: ActiveFilter = { dimension: "cloud_service", value: "Function Duration" }
		// A service splits by region first, as it did before resources were a dimension.
		expect(drilledInto({}, service, withProjects).groupBy).toBe("region")
		// Under a region it moves on to the projects, where the org has any, else to accounts.
		expect(drilledInto({ region: ["iad1"] }, service, withProjects).groupBy).toBe("resource")
		// A GitHub product goes on to its repositories the same way.
		expect(
			drilledInto(
				{ provider: ["github"], region: ["global"] },
				{ dimension: "cloud_service", value: "Actions" },
				withProjects,
			).groupBy,
		).toBe("resource")
		expect(drilledInto({ region: ["iad1"] }, service, without).groupBy).toBe("account")
		// A project splits by its services.
		expect(drilledInto({}, { dimension: "resource", value: "web" }, withProjects)).toEqual({
			resource: ["web"],
			groupBy: "cloud_service",
		})
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
