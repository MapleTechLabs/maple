import { describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
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
		labelsJson: JSON.stringify({ env: "prod" }),
	}

	it("marshals a row with parsed labels", async () => {
		const result = await Effect.runPromise(toInternalScrapeTarget(baseRow))
		expect(Option.isSome(result)).toBe(true)
		if (Option.isNone(result)) return
		expect(result.value.id).toBe(baseRow.id)
		expect(result.value.orgId).toBe("org_1")
		expect(result.value.serviceName).toBe("node")
		expect(result.value.scrapeIntervalSeconds).toBe(15)
		expect(result.value.labels).toEqual({ env: "prod" })
	})

	it("degrades unparseable labelsJson to an empty record", async () => {
		const result = await Effect.runPromise(
			toInternalScrapeTarget({ ...baseRow, labelsJson: "{not json" }),
		)
		expect(Option.isSome(result)).toBe(true)
		if (Option.isNone(result)) return
		expect(result.value.labels).toEqual({})
	})

	it("handles null labelsJson and null serviceName", async () => {
		const result = await Effect.runPromise(
			toInternalScrapeTarget({ ...baseRow, labelsJson: null, serviceName: null }),
		)
		expect(Option.isSome(result)).toBe(true)
		if (Option.isNone(result)) return
		expect(result.value.labels).toEqual({})
		expect(result.value.serviceName).toBeNull()
	})

	it("drops rows that violate the schema brands instead of failing the list", async () => {
		const outOfRange = await Effect.runPromise(
			toInternalScrapeTarget({ ...baseRow, scrapeIntervalSeconds: 2 }),
		)
		expect(Option.isNone(outOfRange)).toBe(true)
	})
})
