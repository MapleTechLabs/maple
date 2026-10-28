import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { confirmedRecord, needsValidationRecord } from "./__fixtures__/records"
import {
	type Candidate,
	candidateErrors,
	candidateRecord,
	CandidateVerdict,
	decodeAgentJson,
	HunterResult,
} from "./results"
import { findingsErrors } from "./validators"

const hunterJson = JSON.stringify({
	units: [
		{
			coverage_id: "u1",
			disposition: "covered",
			reviewed_paths: ["src/a.ts"],
			checks: [
				{
					agent_id: "hunter-1",
					reviewed_paths: ["src/a.ts"],
					invariant: "org scope",
					method: "source",
					result: "scoped",
					artifact: null,
				},
			],
			candidate_fingerprints: [],
			unresolved: [],
		},
	],
	candidates: [],
	hardening: [],
	uncovered: [],
})

describe("decodeAgentJson", () => {
	it("decodes exactly one JSON object", async () => {
		const result = await Effect.runPromise(decodeAgentJson("hunter", HunterResult, hunterJson))
		expect(result.units[0]?.disposition).toBe("covered")
	})

	it("accepts the object inside a lone json fence", async () => {
		const result = await Effect.runPromise(
			decodeAgentJson("hunter", HunterResult, `\`\`\`json\n${hunterJson}\n\`\`\``),
		)
		expect(result.units).toHaveLength(1)
	})

	it("discards a fence that names another language", async () => {
		const exit = await Effect.runPromiseExit(
			decodeAgentJson("hunter", HunterResult, `\`\`\`yaml\n${hunterJson}\n\`\`\``),
		)
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("discards a prose-wrapped result instead of repairing it", async () => {
		const exit = await Effect.runPromiseExit(
			decodeAgentJson("hunter", HunterResult, `Here is my result:\n${hunterJson}`),
		)
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("discards a result that breaks its contract", async () => {
		const exit = await Effect.runPromiseExit(decodeAgentJson("hunter", HunterResult, '{"units": "none"}'))
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("requires a verifier's record to match the branch its decision names", async () => {
		const mismatched = JSON.stringify({ decision: "rejected", record: confirmedRecord })
		const exit = await Effect.runPromiseExit(decodeAgentJson("verifier", CandidateVerdict, mismatched))
		expect(Exit.isFailure(exit)).toBe(true)
	})
})

describe("candidateErrors", () => {
	const { verdict: _verdict, ...fields } =
		confirmedRecord.verdict === "confirmed" ? confirmedRecord : (undefined as never)
	const candidate: Candidate = { proposed_verdict: "confirmed", ...fields }

	it("passes a candidate that is a well-formed confirmed record", () => {
		expect(candidateErrors(candidate)).toEqual([])
	})

	it("reports a candidate whose fingerprint breaks the skill's pattern", () => {
		expect(candidateErrors({ ...candidate, fingerprint: "has spaces" }).length).toBeGreaterThan(0)
	})
})

describe("candidateRecord", () => {
	const { verdict: _verdict, ...fields } = needsValidationRecord
	const estimated_severity = {
		likelihood: { score: "medium", reason: "any member reaches the route" },
		impact: { score: "high", reason: "cross-tenant key roll" },
		overall_severity: "high",
	} as const
	const lead: Candidate = { proposed_verdict: "needs_validation", ...fields, estimated_severity }

	it("leaves a lead's estimate out of the record the upstream validator checks", () => {
		expect(candidateRecord(lead)).toEqual(needsValidationRecord)
		expect(candidateErrors(lead)).toEqual([])
		// The upstream schema refuses fields it does not define, so the estimate must never reach it.
		const polluted = { ...needsValidationRecord, estimated_severity }
		expect(findingsErrors([polluted]).length).toBeGreaterThan(0)
	})
})
