import { CostSourceSummary } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { facetFilters, keyLabel, onlyFilter, toggledFilter } from "./derive"
import { keyDetail, keyMark } from "./marks"

const source = (
	provider: CostSourceSummary["provider"],
	accountId: string,
	id = "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e1f",
): CostSourceSummary =>
	Schema.decodeSync(CostSourceSummary)({
		id,
		provider,
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
