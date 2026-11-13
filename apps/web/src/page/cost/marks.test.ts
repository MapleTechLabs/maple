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
		expect(keyMark("cloud_service", "Models", both)?.icon).toBe(aws)
		expect(keyMark("service_category", "Developer Tools", [])?.icon).toBe("CodeIcon")
		// GitHub bills no region: its rows are `global`, which is the globe and not a logo.
		expect(keyMark("region", "global", both)?.icon).toBe("GlobeIcon")
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
