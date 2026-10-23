import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { confirmedRecord, needsValidationRecord, plannedUnit } from "./__fixtures__/records"
import { coverageId, safeCoverageId, validateFindings, validateLedger } from "./validators"

describe("coverageId", () => {
	it("percent-encodes each canonical reference and joins them with ::", () => {
		expect(
			coverageId({
				surface: "a/b.ts#GET /x",
				boundary: "auth",
				subsystem: "api",
				attack_class: "ATTACK-CLASSES.md#Injection",
			}),
		).toBe("a%2Fb.ts%23GET%20%2Fx::auth::api::ATTACK-CLASSES.md%23Injection")
	})

	it("appends the lifecycle when the unit has one", () => {
		const id = coverageId({
			surface: "s",
			boundary: "b",
			subsystem: "x",
			attack_class: "c",
			lifecycle: "on delete",
		})
		expect(id.endsWith("::on%20delete")).toBe(true)
	})
})

describe("safeCoverageId", () => {
	it("answers undefined for a reference the skill's rules refuse, where the upstream helper throws", () => {
		const refs = { surface: " src/a.ts", boundary: "b", subsystem: "s", attack_class: "c" }
		expect([safeCoverageId(refs), safeCoverageId({ ...refs, surface: "src/a.ts" })]).toEqual([
			undefined,
			"src%2Fa.ts::b::s::c",
		])
	})
})

describe("validateLedger", () => {
	it("accepts a planned unit with empty evidence", async () => {
		const ledger = await Effect.runPromise(validateLedger([plannedUnit]))
		expect(ledger[0]?.status).toBe("planned")
	})

	it("rejects a covered unit with no owner or checks, per the skill's state table", async () => {
		const exit = await Effect.runPromiseExit(validateLedger([{ ...plannedUnit, status: "covered" }]))
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("rejects a unit whose coverage_id does not derive from its canonical references", async () => {
		const exit = await Effect.runPromiseExit(validateLedger([{ ...plannedUnit, coverage_id: "made-up" }]))
		expect(Exit.isFailure(exit)).toBe(true)
	})
})

describe("validateFindings", () => {
	it("accepts confirmed and needs_validation records sorted by fingerprint", async () => {
		const findings = await Effect.runPromise(
			validateFindings([{ ...needsValidationRecord, fingerprint: "keys/other" }, confirmedRecord]),
		)
		expect(findings.map((f) => f.verdict)).toEqual(["needs_validation", "confirmed"])
	})

	it("rejects findings out of fingerprint order", async () => {
		const exit = await Effect.runPromiseExit(
			validateFindings([confirmedRecord, { ...needsValidationRecord, fingerprint: "keys/other" }]),
		)
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("rejects severity on a needs_validation record", async () => {
		const exit = await Effect.runPromiseExit(
			validateFindings([
				{
					...needsValidationRecord,
					severity: confirmedRecord.verdict === "confirmed" ? confirmedRecord.severity : null,
				},
			]),
		)
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("rejects a multi-step trace that does not begin at an entrypoint", async () => {
		const [first, second] = confirmedRecord.trace
		const exit = await Effect.runPromiseExit(
			validateFindings([{ ...confirmedRecord, trace: [{ ...first!, kind: "propagation" }, second!] }]),
		)
		expect(Exit.isFailure(exit)).toBe(true)
	})
})
