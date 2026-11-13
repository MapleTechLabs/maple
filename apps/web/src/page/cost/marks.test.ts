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

	test("a Vercel account reads as the team it is, with the Vercel mark and nothing aside", () => {
		const vercel = [...sources, source("vercel", "acme", "0195f1c2-7a3b-7c4d-8e5f-6a7b8c9d0e21")]
		// The slug is how the team is known, so it stays in the label also while it is the only team.
		expect(keyLabel("account", "acme", vercel)).toBe("Vercel acme")
		expect(keyDetail("account", "acme", vercel)).toBeNull()
		expect(keyMark("account", "acme", vercel)?.icon).toBe(keyMark("provider", "vercel", [])?.icon)
		expect(keyLabel("provider", "vercel")).toBe("Vercel")
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
