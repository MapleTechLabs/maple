import { describe, expect, it } from "vitest"
import { Effect, Option, Schema } from "effect"
import { ScrapeResultReportList } from "@maple/domain/http"
import { isValidInternalBearer } from "../lib/internal-auth"
import { toInternalScrapeTarget } from "./scraper-internal.http"

describe("internal bearer auth", () => {
	it("validates internal bearer tokens with exact match", () => {
		expect(isValidInternalBearer("Bearer secret-token", "secret-token")).toBe(true)
		expect(isValidInternalBearer("Bearer wrong", "secret-token")).toBe(false)
		expect(isValidInternalBearer(undefined, "secret-token")).toBe(false)
		expect(isValidInternalBearer("Bearer secret-token", undefined)).toBe(false)
		expect(isValidInternalBearer("secret-token", "secret-token")).toBe(false)
	})
})

describe("toInternalScrapeTarget", () => {
	const baseRow = {
		id: "11111111-1111-4111-8111-111111111111",
		orgId: "org_1",
		name: "Node Exporter",
		serviceName: "node",
		url: "https://node.example.com:9100/metrics",
		scrapeIntervalSeconds: 15,
		labelsJson: { env: "prod" },
	}

	const INGEST_KEY = "maple_pk_test_key"

	it("marshals a row with parsed labels and the org's ingest key", async () => {
		const result = await Effect.runPromise(toInternalScrapeTarget(baseRow, INGEST_KEY))
		expect(Option.isSome(result)).toBe(true)
		if (Option.isNone(result)) return
		expect(result.value.id).toBe(baseRow.id)
		expect(result.value.orgId).toBe("org_1")
		expect(result.value.serviceName).toBe("node")
		expect(result.value.scrapeIntervalSeconds).toBe(15)
		expect(result.value.labels).toEqual({ env: "prod" })
		expect(result.value.ingestKey).toBe(INGEST_KEY)
	})

	it("degrades invalid labelsJson to an empty record", async () => {
		// jsonb drift: the column should hold Record<string, string>, but a row
		// written by an older deploy (or by hand) may not — the decode guard must
		// degrade it to {} instead of failing the list.
		const driftedLabels: unknown = { env: 123 }
		const result = await Effect.runPromise(
			toInternalScrapeTarget(
				{ ...baseRow, labelsJson: driftedLabels as Record<string, string> },
				INGEST_KEY,
			),
		)
		expect(Option.isSome(result)).toBe(true)
		if (Option.isNone(result)) return
		expect(result.value.labels).toEqual({})
	})

	it("handles null labelsJson and null serviceName", async () => {
		const result = await Effect.runPromise(
			toInternalScrapeTarget({ ...baseRow, labelsJson: null, serviceName: null }, INGEST_KEY),
		)
		expect(Option.isSome(result)).toBe(true)
		if (Option.isNone(result)) return
		expect(result.value.labels).toEqual({})
		expect(result.value.serviceName).toBeNull()
	})

	it("drops rows that violate the schema brands instead of failing the list", async () => {
		const outOfRange = await Effect.runPromise(
			toInternalScrapeTarget({ ...baseRow, scrapeIntervalSeconds: 2 }, INGEST_KEY),
		)
		expect(Option.isNone(outOfRange)).toBe(true)
	})

	it("expands a discovered sub-target with its url, key, and merged labels", async () => {
		const result = await Effect.runPromise(
			toInternalScrapeTarget(baseRow, INGEST_KEY, {
				url: "https://branch-1.metrics.psdb.cloud/metrics",
				subTargetKey: "branch-1",
				labels: { planetscale_database_branch_id: "branch-1", env: "discovery" },
			}),
		)
		expect(Option.isSome(result)).toBe(true)
		if (Option.isNone(result)) return
		expect(result.value.id).toBe(baseRow.id)
		expect(result.value.url).toBe("https://branch-1.metrics.psdb.cloud/metrics")
		expect(result.value.subTargetKey).toBe("branch-1")
		// The target's own labelsJson wins over discovery labels on conflicts.
		expect(result.value.labels).toEqual({
			planetscale_database_branch_id: "branch-1",
			env: "prod",
		})
	})

	it("defaults subTargetKey to null for plain targets", async () => {
		const result = await Effect.runPromise(toInternalScrapeTarget(baseRow, INGEST_KEY))
		expect(Option.isSome(result)).toBe(true)
		if (Option.isNone(result)) return
		expect(result.value.subTargetKey).toBeNull()
	})
})

describe("ScrapeResultReportList decoding", () => {
	const decode = Schema.decodeUnknownSync(ScrapeResultReportList)

	it("accepts reports with check metadata", () => {
		const reports = decode([
			{
				targetId: "11111111-1111-4111-8111-111111111111",
				scrapedAt: 1750000000000,
				error: null,
				subTargetKey: "branch-1",
				durationMs: 250,
				samplesScraped: 120,
				samplesPostMetricRelabeling: 118,
			},
		])
		expect(reports[0]?.durationMs).toBe(250)
		expect(reports[0]?.samplesScraped).toBe(120)
		expect(reports[0]?.samplesPostMetricRelabeling).toBe(118)
	})

	it("accepts legacy reports without check metadata (older scraper deploys)", () => {
		const reports = decode([
			{
				targetId: "11111111-1111-4111-8111-111111111111",
				scrapedAt: 1750000000000,
				error: "target returned HTTP 503",
			},
		])
		expect(reports[0]?.error).toBe("target returned HTTP 503")
		expect(reports[0]?.durationMs).toBeUndefined()
	})
})
