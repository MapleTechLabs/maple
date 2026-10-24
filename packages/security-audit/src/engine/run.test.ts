import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Findings, Ledger } from "../schema"
import { ledgerErrors } from "../validators"
import {
	baseInput,
	confirmed,
	emptyCritic,
	EXPORT,
	FINGERPRINT,
	hunterAnswer,
	idOf,
	json,
	KEYS,
	keysCandidate,
	lowered,
	rejectedRecord,
	runScripted,
	SEARCH,
} from "./__fixtures__/harness"
import type { AgentInvocation } from "./ports"
import { isMaterial } from "./validate"

const ALL = [KEYS, SEARCH, EXPORT].map(idOf)

/** A deep run where the first post-wave critic finds one missing unit and later critics find none. */
const happy =
	(overrides: { readonly record?: (i: AgentInvocation) => string } = {}) =>
	(i: AgentInvocation) => {
		switch (i.role) {
			case "recon":
				return `facts from ${i.agentId}`
			case "synthesis":
				return json({ architecture_md: "An API with org-scoped keys.", units: [KEYS, SEARCH] })
			case "hunter":
				return json(hunterAnswer(i, ALL))
			case "critic":
				return json(
					i.agentId === "critic-w1-post"
						? {
								...emptyCritic,
								missing_units: [{ ...EXPORT, reason: "export route unmapped" }],
								stop: false,
							}
						: emptyCritic,
				)
			case "candidate-verifier":
				return json({ decision: "confirmed", record: confirmed() })
			case "record-verifier":
				return overrides.record?.(i) ?? json({ decision: "verified", fingerprint: FINGERPRINT })
		}
	}

const roles = (invocations: ReadonlyArray<AgentInvocation>) => invocations.map((i) => i.agentId)

describe("runAudit, deep profile", () => {
	it("runs every phase in order and completes with a validated ledger and findings", async () => {
		const { result, recorded } = await runScripted(baseInput(), happy())
		expect(roles(recorded.invocations)).toEqual([
			"recon-1a",
			"recon-1b",
			"recon-1c",
			"recon-1d",
			"synthesis-1",
			"hunter-w1-1",
			"hunter-w1-2",
			"critic-w1-post",
			"hunter-w2-1",
			"critic-w2-post",
			"critic-w2-final",
			"verify-1",
			"record-1-0",
		])
		expect(result.status).toBe("complete")
		expect(result.findings.map((f) => [f.fingerprint, f.verdict])).toEqual([[FINGERPRINT, "confirmed"]])
		expect(Object.fromEntries(result.ledger.map((u) => [u.surface, u.status]))).toEqual({
			"POST /keys": "candidate",
			"POST /search": "covered",
			"POST /export": "covered",
		})
		expect(ledgerErrors(recorded.ledger)).toEqual([])
		expect(recorded.reports?.report).toContain("| high | Any org member can roll another org's API key |")
	})

	it("produces a ledger and findings that encode through the stored schemas", async () => {
		const { result } = await runScripted(baseInput(), happy())
		const encoded = Schema.encodeUnknownSync(Ledger)(result.ledger)
		expect(Object.fromEntries(encoded.map((u) => [u.surface, u.priority ?? null]))).toEqual({
			"POST /keys": 1,
			"POST /search": 2,
			"POST /export": null,
		})
		expect(Schema.encodeUnknownSync(Findings)(result.findings).map((f) => f.fingerprint)).toEqual([
			FINGERPRINT,
		])
	})

	it("hunts the highest-priority unit first", async () => {
		const { recorded } = await runScripted(baseInput(), happy())
		const first = recorded.invocations.find((i) => i.agentId === "hunter-w1-1")
		expect(first?.prompt).toContain(`"coverage_id": "${idOf(KEYS)}"`)
	})

	it("discards a prose-wrapped hunter result and re-hunts its unit with a fresh hunter", async () => {
		const { result, recorded } = await runScripted(baseInput(), (i) =>
			i.agentId === "hunter-w1-2" ? `Done! ${json(hunterAnswer(i, ALL))}` : happy()(i),
		)
		expect(recorded.events).toContainEqual(
			expect.objectContaining({ _tag: "Agent", agentId: "hunter-w1-2", outcome: "discarded" }),
		)
		const rehunt = recorded.invocations.filter(
			(i) => i.role === "hunter" && i.prompt.includes(`"coverage_id": "${idOf(SEARCH)}"`),
		)
		expect(rehunt.map((i) => i.agentId)).toEqual(["hunter-w1-2", "hunter-w2-1"])
		expect(result.ledger.find((u) => u.surface === "POST /search")?.status).toBe("covered")
	})

	it("archives a reassigned unit's attempt and gives it to a fresh hunter", async () => {
		const { result, recorded } = await runScripted(baseInput(), (i) =>
			i.agentId === "critic-w1-post"
				? json({ ...emptyCritic, reassign_ids: [idOf(SEARCH)], stop: false })
				: happy()(i),
		)
		const search = result.ledger.find((u) => u.coverage_id === idOf(SEARCH))
		expect(search?.attempts.map((a) => [a.agent_id, a.status, a.wave])).toEqual([
			["hunter-w1-2", "covered", 1],
		])
		expect([search?.agent_id, search?.wave]).toEqual(["hunter-w2-1", 2])
		expect(ledgerErrors(recorded.ledger)).toEqual([])
	})

	it("refuses a critic's missing unit that names a block the skill does not define", async () => {
		const bogus = {
			...EXPORT,
			ordinary_attack_class_block: "ATTACK-CLASSES.md#Export abuse",
			reason: "unmapped",
		}
		const { result } = await runScripted(baseInput(), (i) =>
			i.agentId === "critic-w1-post"
				? json({ ...emptyCritic, missing_units: [bogus], stop: false })
				: happy()(i),
		)
		expect(result.ledger.map((u) => u.surface)).toEqual(expect.not.arrayContaining(["POST /export"]))
	})

	it("refuses a local check without a promoted artifact and returns the unit to planned", async () => {
		const { recorded } = await runScripted(baseInput({ maxWaves: 1 }), (i) => {
			if (i.agentId !== "hunter-w1-2") return happy()(i)
			const answer = hunterAnswer(i, ALL)
			return json({
				...answer,
				units: answer.units.map((u) => ({
					...u,
					checks: u.checks.map((c) => ({
						...c,
						method: "local",
						artifact: "agents/hunter-w1-2/artifacts/x.txt",
					})),
				})),
			})
		})
		expect(recorded.ledger.find((u) => u.surface === "POST /search")?.status).toBe("deferred")
	})
})

describe("runAudit, budget", () => {
	it("launches no agent when the budget cannot fund reconnaissance, a hunter and the reserves", async () => {
		// 8 covers reconnaissance, synthesis, two critics and a verifier, but no hunter.
		const { result, recorded } = await runScripted(baseInput({ budget: 8 }), happy())
		expect(recorded.invocations).toEqual([])
		expect(result.status).toBe("incomplete")
		expect(result.incompleteReasons).toEqual(["budget_cannot_fund_reconnaissance_and_reserves"])
	})

	it("defers what the allowance cannot reach and keeps the validation reserve for both reviews", async () => {
		const { result, recorded } = await runScripted(baseInput({ budget: 9 }), happy())
		expect(recorded.invocations.filter((i) => i.role === "hunter").map((i) => i.agentId)).toEqual([
			"hunter-w1-1",
		])
		expect(result.ledger.find((u) => u.surface === "POST /search")?.unresolved).toEqual([
			"budget_cannot_reserve_critics_and_validation",
		])
		expect(recorded.invocations).toHaveLength(9)
		// No gap critic out of the validation reserve: the candidate gets its Phase 3 and Phase 5 reviews.
		expect(roles(recorded.invocations).slice(-2)).toEqual(["verify-1", "record-1-0"])
		expect([result.status, result.findings.map((f) => f.verdict)]).toEqual(["complete", ["confirmed"]])
		expect(result.gaps).toContain("budget_cannot_reserve_critics_and_validation")
	})
})

describe("runAudit, record verification", () => {
	it("applies a material replacement only after a fresh verifier agrees", async () => {
		const { result, recorded } = await runScripted(
			baseInput(),
			happy({
				record: (i) =>
					i.agentId === "record-1-0"
						? json({ decision: "replace", reason: "impact overstated", record: lowered() })
						: json({ decision: "verified", fingerprint: FINGERPRINT }),
			}),
		)
		expect(roles(recorded.invocations).filter((id) => id.startsWith("record-"))).toEqual([
			"record-1-0",
			"record-1-1",
		])
		const finding = result.findings[0]
		expect(finding?.verdict === "confirmed" ? finding.severity.overall_severity : undefined).toBe(
			"medium",
		)
	})

	it("drops a record whose material replacement cannot be independently verified", async () => {
		const { result } = await runScripted(
			baseInput(),
			happy({
				record: (i) =>
					json({
						decision: "replace",
						reason: "keeps changing",
						record: i.prompt.includes('"overall_severity": "high"') ? lowered() : confirmed(),
					}),
			}),
		)
		// Every fresh verifier materially replaces the last one's record; past the cap nothing is reported.
		expect(result.findings).toEqual([])
		expect(result.status).toBe("incomplete")
		expect(result.incompleteReasons).toContain("record_verification_incomplete")
	})

	it("keeps a rejected candidate as a rejected record without a second review", async () => {
		const { result, recorded } = await runScripted(baseInput(), (i) =>
			i.role === "candidate-verifier"
				? json({ decision: "rejected", record: rejectedRecord })
				: happy()(i),
		)
		expect(result.findings.map((f) => f.verdict)).toEqual(["rejected"])
		expect(recorded.invocations.some((i) => i.role === "record-verifier")).toBe(false)
	})
})

describe("runAudit, prior runs", () => {
	const priorRun = async () => (await runScripted(baseInput(), happy())).result

	it("carries an unchanged confirmed record to a verifier instead of a hunter", async () => {
		const prior = await priorRun()
		const { result, recorded } = await runScripted(
			baseInput({
				runId: "run-2",
				prior: {
					runId: "run-1",
					sourceRef: "abc123",
					ledger: prior.ledger,
					findings: prior.findings,
				},
			}),
			happy(),
		)
		const keysId = idOf(KEYS)
		expect(
			recorded.invocations.filter(
				(i) => i.role === "hunter" && i.prompt.includes(`"coverage_id": "${keysId}"`),
			),
		).toEqual([])
		const keys = result.ledger.find((u) => u.coverage_id === keysId)
		expect([keys?.prior_status, keys?.status, keys?.agent_id]).toEqual([
			"prior_confirmed_same_source",
			"candidate",
			"verify-1",
		])
		expect(result.findings.map((f) => f.verdict)).toEqual(["confirmed"])
	})

	it("hunts a confirmed record's unit again when its source changed", async () => {
		const prior = await priorRun()
		const { result, recorded } = await runScripted(
			baseInput({
				runId: "run-2",
				prior: {
					runId: "run-1",
					sourceRef: "abc123",
					ledger: prior.ledger,
					findings: prior.findings,
				},
				changedSincePrior: (paths) => paths.some((p) => p.includes("keys")),
			}),
			happy(),
		)
		expect(
			recorded.invocations.some(
				(i) => i.role === "hunter" && i.prompt.includes(`"coverage_id": "${idOf(KEYS)}"`),
			),
		).toBe(true)
		expect(result.ledger.find((u) => u.coverage_id === idOf(KEYS))?.prior_status).toBe(
			"prior_confirmed_changed_source",
		)
	})
})

describe("runAudit, quick profile", () => {
	it("runs one wave and one final critic, defers what the critic accepts, and skips Phase 5", async () => {
		const { result, recorded } = await runScripted(baseInput({ profile: "quick" }), happy())
		expect(recorded.invocations.filter((i) => i.role === "critic").map((i) => i.agentId)).toEqual([
			"critic-w1-post",
		])
		expect(recorded.invocations.some((i) => i.role === "record-verifier")).toBe(false)
		expect(result.ledger.find((u) => u.surface === "POST /export")?.unresolved).toEqual([
			"quick_profile_final_critic",
		])
		expect(recorded.reports?.report).toContain("This is a partial pass.")
	})
})

describe("runAudit, review regressions", () => {
	const priorOf = async () => {
		const { result } = await runScripted(baseInput(), happy())
		return { runId: "run-1", sourceRef: "abc123", ledger: result.ledger, findings: result.findings }
	}

	it("hunts only in-scope prior units in a scoped run and records the rest out of scope", async () => {
		const prior = await priorOf()
		const { result, recorded } = await runScripted(
			baseInput({
				runId: "run-2",
				prior,
				scopePaths: ["src/routes/search.ts"],
				changedSincePrior: () => true,
			}),
			happy(),
		)
		const hunted = recorded.invocations.filter((i) => i.role === "hunter")
		expect(hunted.some((i) => i.prompt.includes(`"coverage_id": "${idOf(EXPORT)}"`))).toBe(false)
		expect(result.ledger.find((u) => u.coverage_id === idOf(EXPORT))?.status).toBe("out_of_scope")
	})

	it("never reuses an agent id when the last wave's final-clean critic still finds work", async () => {
		const { recorded } = await runScripted(baseInput({ maxWaves: 1 }), (i) =>
			i.agentId === "critic-w1-post"
				? json(emptyCritic)
				: i.agentId === "critic-w1-final"
					? json({
							...emptyCritic,
							missing_units: [{ ...EXPORT, reason: "unmapped" }],
							stop: false,
						})
					: happy()(i),
		)
		const ids = roles(recorded.invocations)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("validates a carried record a hunter raised again once, with the hunter's claim", async () => {
		const prior = await priorOf()
		const { recorded } = await runScripted(
			baseInput({
				runId: "run-2",
				prior,
				changedSincePrior: (paths) => paths.some((p) => p.includes("search")),
			}),
			(i) => {
				if (i.role !== "hunter") return happy()(i)
				// The re-hunted search unit raises the carried keys fingerprint again.
				const answer = hunterAnswer(i, ALL)
				return json({
					...answer,
					units: answer.units.map((u) => ({
						...u,
						disposition: "candidate",
						candidate_fingerprints: [FINGERPRINT],
					})),
					candidates: [keysCandidate],
				})
			},
		)
		expect(recorded.invocations.filter((i) => i.role === "candidate-verifier")).toHaveLength(1)
	})

	it("defers a quick run's units whose hunter failed instead of leaving them planned", async () => {
		const { result } = await runScripted(baseInput({ profile: "quick" }), (i) =>
			i.agentId === "hunter-w1-2" ? "not json" : happy()(i),
		)
		expect(result.ledger.filter((u) => u.status === "planned")).toEqual([])
	})

	it("does not count synthesis re-proposing a prior unit as lost coverage", async () => {
		const prior = await priorOf()
		const { result } = await runScripted(baseInput({ runId: "run-2", prior }), happy())
		expect(result.gaps).toEqual([])
	})

	it("treats a prior candidate that never got a verdict as open work", async () => {
		const prior = await priorOf()
		const { result } = await runScripted(
			baseInput({ runId: "run-2", prior: { ...prior, findings: [] } }),
			happy(),
		)
		expect(result.ledger.find((u) => u.coverage_id === idOf(KEYS))?.prior_status).toBe("prior_deferred")
	})

	it("validates a rejected fingerprint again when its new trace reaches other files", async () => {
		const prior = await priorOf()
		const { recorded } = await runScripted(
			baseInput({ runId: "run-2", prior: { ...prior, findings: [rejectedRecord] } }),
			(i) => {
				if (i.role !== "hunter") return happy()(i)
				const answer = hunterAnswer(i, ALL)
				const moved = {
					...keysCandidate,
					evidence: [{ file: "src/services/other.ts", line: 3, description: "new path" }],
				}
				return json({ ...answer, candidates: answer.candidates.length === 0 ? [] : [moved] })
			},
		)
		expect(recorded.invocations.some((i) => i.role === "candidate-verifier")).toBe(true)
	})

	it("does not validate a candidate whose unit result was refused", async () => {
		const { recorded } = await runScripted(baseInput({ maxWaves: 1 }), (i) => {
			if (i.role !== "hunter") return happy()(i)
			const answer = hunterAnswer(i, ALL)
			// The keys unit's check claims another agent's ownership, so that unit result is refused.
			return json({
				...answer,
				units: answer.units.map((u) => ({
					...u,
					checks: u.checks.map((c) => ({ ...c, agent_id: "someone-else" })),
				})),
			})
		})
		expect(recorded.invocations.some((i) => i.role === "candidate-verifier")).toBe(false)
	})
})

describe("runAudit, carrying several records on one unit", () => {
	it("carries every unchanged record a prior unit links and reports each of them", async () => {
		const second = confirmed({
			fingerprint: "keys/second-root-cause",
			title: "Key list leaks other orgs' keys",
		})
		// Verifiers answer for the record their prompt carries.
		const twoRecords = (i: AgentInvocation) => {
			const isSecond = i.prompt.includes("keys/second-root-cause")
			if (i.role === "candidate-verifier")
				return json({ decision: "confirmed", record: isSecond ? second : confirmed() })
			if (i.role === "record-verifier")
				return json({
					decision: "verified",
					fingerprint: isSecond ? "keys/second-root-cause" : FINGERPRINT,
				})
			return happy()(i)
		}
		const { result: first } = await runScripted(baseInput(), (i) => {
			if (i.role === "hunter") {
				const answer = hunterAnswer(i, ALL)
				const { verdict: _v, ...fields } =
					second.verdict === "confirmed" ? second : (undefined as never)
				return json({
					...answer,
					units: answer.units.map((u) =>
						u.disposition === "candidate"
							? { ...u, candidate_fingerprints: [FINGERPRINT, "keys/second-root-cause"] }
							: u,
					),
					candidates:
						answer.candidates.length === 0
							? []
							: [...answer.candidates, { proposed_verdict: "confirmed", ...fields }],
				})
			}
			return twoRecords(i)
		})
		const prior = { runId: "run-1", sourceRef: "abc123", ledger: first.ledger, findings: first.findings }
		const { result } = await runScripted(baseInput({ runId: "run-2", prior }), twoRecords)
		expect(result.findings.map((f) => f.fingerprint)).toEqual([
			"keys/roll-missing-org-scope",
			"keys/second-root-cause",
		])
		expect(ledgerErrors(result.ledger)).toEqual([])
	})
})

describe("runAudit, third review regressions", () => {
	it("hunts a unit carried last run once its record's source changes", async () => {
		const { result: first } = await runScripted(baseInput(), happy())
		const second = await runScripted(
			baseInput({
				runId: "run-2",
				prior: { runId: "run-1", sourceRef: "a", ledger: first.ledger, findings: first.findings },
			}),
			happy(),
		)
		const third = await runScripted(
			baseInput({
				runId: "run-3",
				prior: {
					runId: "run-2",
					sourceRef: "b",
					ledger: second.result.ledger,
					findings: second.result.findings,
				},
				changedSincePrior: (paths) => paths.some((p) => p.includes("keys")),
			}),
			happy(),
		)
		expect(
			third.recorded.invocations.some(
				(i) => i.role === "hunter" && i.prompt.includes(`"coverage_id": "${idOf(KEYS)}"`),
			),
		).toBe(true)
	})
})

describe("runAudit, fourth review regressions", () => {
	it("decides every unit that carries the same prior record with one verifier", async () => {
		const searchId = idOf(SEARCH)
		// Run 1: the search unit's hunter raises the keys record too, so both units link it.
		const { result: first } = await runScripted(baseInput(), (i) => {
			if (i.role !== "hunter") return happy()(i)
			const answer = hunterAnswer(i, ALL)
			const owned = answer.units.some((u) => u.coverage_id === searchId)
			return json({
				...answer,
				units: answer.units.map((u) =>
					u.coverage_id === searchId
						? { ...u, disposition: "candidate", candidate_fingerprints: [FINGERPRINT] }
						: u,
				),
				candidates: owned && answer.candidates.length === 0 ? [keysCandidate] : answer.candidates,
			})
		})
		const prior = { runId: "run-1", sourceRef: "abc123", ledger: first.ledger, findings: first.findings }
		const { result, recorded } = await runScripted(baseInput({ runId: "run-2", prior }), happy())
		const status = (id: string) => result.ledger.find((u) => u.coverage_id === id)?.status
		expect([status(idOf(KEYS)), status(searchId)]).toEqual(["candidate", "candidate"])
		expect(recorded.invocations.filter((i) => i.role === "candidate-verifier")).toHaveLength(1)
		expect(result.status).toBe("complete")
		expect(ledgerErrors(result.ledger)).toEqual([])
	})

	it("reports a run whose budget leaves no hunter for its planned units as incomplete", async () => {
		const prior = await runScripted(baseInput(), happy())
		const { result, recorded } = await runScripted(
			baseInput({
				runId: "run-2",
				budget: 9,
				prior: {
					runId: "run-1",
					sourceRef: "abc123",
					ledger: prior.result.ledger,
					findings: prior.result.findings,
				},
			}),
			happy(),
		)
		expect(recorded.invocations.some((i) => i.role === "hunter")).toBe(false)
		expect(result.status).toBe("incomplete")
		expect(result.incompleteReasons).toContain("budget_cannot_fund_a_hunter")
	})

	it("does not treat a reworded reason as a material replacement", () => {
		const reworded = confirmed({
			severity: {
				likelihood: { score: "medium", reason: "an attacker needs a valid key id" },
				impact: { score: "high", reason: "writes across tenants" },
				overall_severity: "high",
			},
			confidence: { score: "medium", reason: "the full source trace was read" },
		})
		expect(isMaterial(confirmed(), reworded)).toBe(false)
		expect(isMaterial(confirmed(), lowered())).toBe(true)
	})

	it("logs only where a discarded result broke its contract", async () => {
		const { recorded } = await runScripted(baseInput(), (i) =>
			i.agentId === "hunter-w1-2" ? json({ units: "token-ABC123-do-not-log" }) : happy()(i),
		)
		const discarded = recorded.events.find(
			(e) => e._tag === "Agent" && e.agentId === "hunter-w1-2" && e.outcome === "discarded",
		)
		const message = discarded?._tag === "Agent" ? discarded.message : undefined
		expect(message).toContain("at: units")
		expect(message).not.toContain("ABC123")
	})
})
