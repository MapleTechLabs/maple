import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { AiTriageSubmission, normalizeTriageSubmission } from "./ai-triage"

const decode = Schema.decodeUnknownSync(AiTriageSubmission)

describe("normalizeTriageSubmission", () => {
	it("keeps a complete submission intact and reports nothing filled", () => {
		const { report, filled } = normalizeTriageSubmission(
			decode({
				headline: "Hyperdrive stalls the pool's first dial",
				summary: "Every 5xx in the window is a connection timeout.",
				suspectedCause: "The Hyperdrive config stalls on dial, so the pool never hands out a client.",
				severityAssessment: "high",
				affectedScope: "maple-api, all DB-backed routes",
				evidence: [
					{
						traceIds: ["t1"],
						logPatterns: ["CONNECT_TIMEOUT"],
						relatedServices: ["maple-api"],
						note: "n",
					},
				],
				suggestedActions: ["Recreate the Hyperdrive config"],
				confidence: "high",
				ruledOut: ["Deploy: service.version unchanged across the window"],
			}),
		)
		expect(filled).toEqual([])
		expect(report.confidence).toBe("high")
		expect(report.severityAssessment).toBe("high")
		expect(report.evidence[0]?.logPatterns).toEqual(["CONNECT_TIMEOUT"])
	})

	/** The exact failure that killed seven of fifteen finished turns on 2026-09-19. */
	it("files a report when the model omitted suggestedActions", () => {
		const { report, filled } = normalizeTriageSubmission(
			decode({
				summary: "s",
				suspectedCause: "c",
				affectedScope: "a",
				evidence: [],
				confidence: "medium",
			}),
		)
		expect(filled).toEqual(["suggestedActions"])
		expect(report.suggestedActions).toEqual([])
		expect(report.summary).toBe("s")
	})

	it("completes a partial evidence entry rather than rejecting the report around it", () => {
		const { report, filled } = normalizeTriageSubmission(
			decode({ evidence: [{ traceIds: ["t1"], note: "the failing span" }] }),
		)
		expect(report.evidence[0]).toEqual({
			traceIds: ["t1"],
			logPatterns: [],
			relatedServices: [],
			note: "the failing span",
		})
		expect(filled).not.toContain("evidence")
	})

	/** `evidence[0].logPatterns` is one of the four keys prod saw missing; it has to be countable. */
	it("names the omitted field inside an evidence entry, not just the entry", () => {
		const { filled } = normalizeTriageSubmission(decode({ evidence: [{ traceIds: ["t1"], note: "n" }] }))
		expect(filled).toContain("evidence[0].logPatterns")
		expect(filled).toContain("evidence[0].relatedServices")
		expect(filled).not.toContain("evidence[0].traceIds")
	})

	it("indexes each entry separately so two partials do not read as one", () => {
		const { filled } = normalizeTriageSubmission(
			decode({
				evidence: [
					{ traceIds: ["t1"], logPatterns: ["p"], relatedServices: ["s"], note: "n" },
					{ traceIds: ["t2"], logPatterns: ["p"], relatedServices: ["s"] },
				],
			}),
		)
		expect(filled.filter((field) => field.startsWith("evidence"))).toEqual(["evidence[1].note"])
	})

	it("drops a severity the report cannot hold and says it did", () => {
		const { report, filled } = normalizeTriageSubmission(decode({ severityAssessment: "unclassified" }))
		expect(report.severityAssessment).toBeUndefined()
		expect(filled).toContain("severityAssessment")
	})

	/** An omission is itself evidence the run was not confident, so it must not read as one that was. */
	it("defaults a missing confidence to low", () => {
		const { report, filled } = normalizeTriageSubmission(decode({}))
		expect(report.confidence).toBe("low")
		expect(filled).toContain("confidence")
	})

	it("treats whitespace-only prose as absent", () => {
		const { report, filled } = normalizeTriageSubmission(decode({ summary: "   " }))
		expect(filled).toContain("summary")
		expect(report.summary).not.toBe("   ")
	})

	it("leaves the optional narrative fields off rather than inventing them", () => {
		const { report } = normalizeTriageSubmission(decode({ summary: "s" }))
		expect(report.headline).toBeUndefined()
		expect(report.ruledOut).toBeUndefined()
		expect(report.unchecked).toBeUndefined()
	})
})

/** The shapes prod models sent where a list belongs; each one used to end the turn. */
describe("AiTriageSubmission list leniency", () => {
	it("reads a bare string in evidence as one entry's note", () => {
		expect(decode({ evidence: "p99 tripled at 14:02" }).evidence).toEqual([
			{ note: "p99 tripled at 14:02" },
		])
	})

	it("reads string entries inside evidence as notes", () => {
		expect(decode({ evidence: ["a", { traceIds: ["t1"] }] }).evidence).toEqual([
			{ note: "a" },
			{ traceIds: ["t1"] },
		])
	})

	it("wraps a single evidence object in a list", () => {
		expect(decode({ evidence: { note: "n", traceIds: ["t1"] } }).evidence).toEqual([
			{ note: "n", traceIds: ["t1"] },
		])
	})

	it("parses a JSON-encoded evidence list", () => {
		expect(decode({ evidence: '[{"note":"n"}]' }).evidence).toEqual([{ note: "n" }])
	})

	it("wraps a bare suggestedActions string", () => {
		expect(decode({ suggestedActions: "Roll back" }).suggestedActions).toEqual(["Roll back"])
	})

	it("parses a JSON-encoded suggestedActions list", () => {
		expect(decode({ suggestedActions: '["a","b"]' }).suggestedActions).toEqual(["a", "b"])
	})

	it("still rejects a value that is no list shape at all", () => {
		expect(() => decode({ suggestedActions: 42 })).toThrow()
	})
})
