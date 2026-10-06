import { warehouseDateTime, type WarehouseDateTime } from "@maple/query-engine"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toInputSchema } from "../tools/registry"
import { WarehouseTimeInput } from "@maple/query-engine"
import { resolveTimeRange, resolveWindow } from "./time"

const optionalTimeParam = (description: string) =>
	Schema.optional(WarehouseTimeInput).annotate({ description })

/**
 * Tools receive their bounds already decoded by `optionalTimeParam`, so the
 * tests do the same rather than hand-building the brand — that way the
 * parameter schema and the resolver are exercised on the same path production
 * uses.
 */
const decodeBound = Schema.decodeUnknownResult(Schema.Struct({ t: optionalTimeParam("test bound") }))
const bound = (input: string): WarehouseDateTime => {
	const result = decodeBound({ t: input })
	if (result._tag !== "Success" || result.success.t === undefined) {
		throw new Error(`expected ${input} to decode as a time bound`)
	}
	return result.success.t
}

describe("optionalTimeParam", () => {
	it("canonicalizes the encodings a model reaches for", () => {
		expect(bound("2026-03-30 14:30:00")).toBe("2026-03-30 14:30:00")
		expect(bound("2026-03-30T14:30:00Z")).toBe("2026-03-30 14:30:00")
		expect(bound("2026-03-30T14:30:00.000Z")).toBe("2026-03-30 14:30:00")
		expect(bound("2026-03-30T14:30:00+09:00")).toBe("2026-03-30 05:30:00")
	})

	it("omits cleanly", () => {
		const result = decodeBound({})
		expect(result._tag).toBe("Success")
	})

	// The value that reached ClickHouse as toDateTime('2026-08-47:53'). It now
	// fails at the parameter boundary, before any tool body runs.
	it("rejects the malformed bounds that used to reach the warehouse", () => {
		expect(decodeBound({ t: "2026-08-47:53" })._tag).toBe("Failure")
		expect(decodeBound({ t: "not-a-date" })._tag).toBe("Failure")
		expect(decodeBound({ t: "2026-02-30 00:00:00" })._tag).toBe("Failure")
		expect(decodeBound({ t: "2026" })._tag).toBe("Failure")
	})

	it("names the offending value so the model can self-correct", () => {
		const result = decodeBound({ t: "2026-08-47:53" })
		expect(result._tag).toBe("Failure")
		expect(String(result._tag === "Failure" ? result.failure : "")).toContain("2026-08-47:53")
	})

	/**
	 * The published schema is what a model reads before it ever calls the tool,
	 * and this file's history is one of parameters that published as something
	 * other than what the decoder accepts. A branded, filtered, transformed
	 * schema is exactly the kind that can render as a `$ref` or sprout a
	 * constraint clients disagree about — so pin it to a plain string.
	 */
	it("publishes as a plain string parameter", () => {
		const published = toInputSchema(Schema.Struct({ start_time: optionalTimeParam("Start of range") }))
		expect(published).toMatchObject({
			type: "object",
			properties: { start_time: { type: "string", description: "Start of range" } },
		})
		expect(published.$defs).toBeUndefined()
		expect(published.required).toBeUndefined()
	})
})

describe("resolveTimeRange", () => {
	it("passes through bounds the parameter schema already canonicalized", () => {
		const { st, et } = resolveTimeRange(bound("2026-03-30T10:00:00Z"), bound("2026-03-30T16:00:00Z"))
		expect(st).toBe("2026-03-30 10:00:00")
		expect(et).toBe("2026-03-30 16:00:00")
	})

	it("returns default window when neither is provided", () => {
		const { st, et } = resolveTimeRange(undefined, undefined)
		expect(st).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		expect(et).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		const startMs = new Date(st.replace(" ", "T") + "Z").getTime()
		const endMs = new Date(et.replace(" ", "T") + "Z").getTime()
		expect((endMs - startMs) / 3_600_000).toBeCloseTo(6, 0)
	})

	it("defaults only the bound that is missing", () => {
		const onlyStart = resolveTimeRange(bound("2026-03-30T10:00:00+09:00"), undefined)
		expect(onlyStart.st).toBe("2026-03-30 01:00:00")
		expect(onlyStart.et).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

		const onlyEnd = resolveTimeRange(undefined, bound("2026-03-30T16:00:00Z"))
		expect(onlyEnd.st).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		expect(onlyEnd.et).toBe("2026-03-30 16:00:00")
	})

	it("preserves numeric third-arg as defaultHours (back-compat)", () => {
		const { st, et } = resolveTimeRange(undefined, undefined, 1)
		const startMs = new Date(st.replace(" ", "T") + "Z").getTime()
		const endMs = new Date(et.replace(" ", "T") + "Z").getTime()
		expect((endMs - startMs) / 3_600_000).toBeCloseTo(1, 0)
	})

	it("flags an over-wide range without truncating it", () => {
		const result = resolveTimeRange(bound("2026-03-01T00:00:00Z"), bound("2026-03-30T00:00:00Z"), {
			maxHours: 24 * 7,
		})
		expect(result.exceeded).toBe(true)
		// The window is reported back verbatim — callers reject rather than clamp,
		// so the agent never receives a silently narrowed answer.
		expect(result.st).toBe("2026-03-01 00:00:00")
		expect(result.et).toBe("2026-03-30 00:00:00")
		expect(result.maxHours).toBe(24 * 7)
		expect(result.requestedHours).toBe(29 * 24)
	})

	it("accepts a range within maxHours", () => {
		const result = resolveTimeRange(bound("2026-03-29T00:00:00Z"), bound("2026-03-30T00:00:00Z"), {
			maxHours: 24 * 7,
		})
		expect(result.exceeded).toBe(false)
	})

	it("never flags exceeded when no cap is set", () => {
		expect(resolveTimeRange(bound("2020-01-01T00:00:00Z"), bound("2026-03-30T00:00:00Z")).exceeded).toBe(
			false,
		)
	})

	it("mints default bounds through the brand", () => {
		// Guards the one path that builds a bound from a number rather than by
		// decoding, so a formatting regression there fails here.
		expect(warehouseDateTime(Date.UTC(2026, 2, 30, 14, 30, 0))).toBe("2026-03-30 14:30:00")
	})
})

describe("resolveWindow", () => {
	const NOW = Date.UTC(2026, 7, 20, 17, 4, 5)
	const resolve = (start?: string, end?: string, maxHours?: number) =>
		resolveWindow(
			start === undefined ? undefined : bound(start),
			end === undefined ? undefined : bound(end),
			{
				defaultHours: 6,
				maxHours,
				tool: "search_logs",
			},
			NOW,
		)

	it("clamps a future end_time to server now and says so", () => {
		const result = resolve("2026-08-20 15:00:00", "2026-08-20 18:30:00")
		expect(result).toMatchObject({
			_tag: "Resolved",
			st: "2026-08-20 15:00:00",
			et: "2026-08-20 17:04:05",
		})
		expect(result._tag === "Resolved" && result.notices.join()).toContain("in the future")
	})

	it("rejects a start_time that is not in the past, naming server now", () => {
		const result = resolve("2026-08-20 18:00:00")
		expect(result._tag).toBe("Rejected")
		expect(result._tag === "Rejected" && result.message).toContain("2026-08-20 17:04:05")
	})

	it("rejects an inverted window", () => {
		expect(resolve("2026-08-20 12:00:00", "2026-08-20 10:00:00")._tag).toBe("Rejected")
	})

	it("warns on a window shorter than a minute", () => {
		const result = resolve("2026-08-20 15:00:00", "2026-08-20 15:00:14")
		expect(result._tag === "Resolved" && result.notices.join()).toContain("only 14s wide")
	})

	it("defaults start_time relative to end_time, not to now", () => {
		expect(resolve(undefined, "2026-08-19 12:00:00")).toMatchObject({ st: "2026-08-19 06:00:00" })
	})

	it("clamps an over-cap window to the cap, keeping end_time", () => {
		const result = resolve("2026-08-07 00:00:00", "2026-08-14 23:59:59", 24 * 7)
		expect(result).toMatchObject({
			_tag: "Resolved",
			st: "2026-08-07 23:59:59",
			et: "2026-08-14 23:59:59",
		})
		const notice = result._tag === "Resolved" ? result.notices.join() : ""
		expect(notice).toContain("at most 7 days")
		expect(notice).not.toContain("query_data")
	})

	it("adds no notice to an ordinary window", () => {
		expect(resolve("2026-08-20 10:00:00", "2026-08-20 16:00:00", 24)).toMatchObject({ notices: [] })
	})
})
