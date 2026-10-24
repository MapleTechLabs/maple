import { describe, expect, it } from "vitest"
import {
	aggregate,
	decodeCaseFile,
	decodeGrades,
	type CaseResult,
	estimateCost,
	type Finding,
	fitsCap,
	type Grades,
	isExecutionOnly,
	locationMatches,
	metricsOf,
	parseEventLines,
	scoreRun,
} from "../../scripts/security-audit-eval/scoring"

const step = (file: string) => ({ kind: "sink" as const, file, line: 1, scope: "f", description: "d" })

const needsValidation = (fingerprint: string, file: string, blockers: Array<string>): Finding => ({
	verdict: "needs_validation",
	fingerprint,
	title: fingerprint,
	description: "d",
	trace: [step(file)],
	evidence: [{ file, line: 1, description: "d" }],
	claimed_root_cause: "c",
	blockers,
	validation_plan: {},
})

const rejected = (fingerprint: string, file: string): Finding => ({
	verdict: "rejected",
	fingerprint,
	title: fingerprint,
	description: "d",
	trace: [step(file)],
	evidence: [],
	claimed_root_cause: "c",
	reason: "guarded",
})

const metrics = (costUsd: number, invocations: number) => ({
	...metricsOf({ status: "complete", events: [], findings: [], wallClockSeconds: 60 }),
	costUsd,
	invocations,
})

const result = (
	key: string,
	language: "typescript" | "go",
	bugIds: Array<string>,
	cost = 10,
): CaseResult => ({
	key,
	case: {
		id: key,
		corpus: language === "typescript" ? "maple" : "public",
		language,
		repo: { name: "r", url: "https://example.invalid/r.git" },
		sha: "a",
		scope: ["src"],
		bugs: [
			{ id: bugIds[0] ?? "b", reference: "#1", fixSha: "f", touchedFiles: ["src/a.ts"] },
			...bugIds
				.slice(1)
				.map((id) => ({ id, reference: "#2", fixSha: "f", touchedFiles: ["src/b.ts"] })),
		],
	},
	profile: "quick",
	budget: 10,
	exitCode: 0,
	metrics: metrics(cost, 10),
	locationMatches: [],
})

const grades = (bugs: Grades["bugs"], spotChecks: Grades["spotChecks"] = []): Grades => ({ bugs, spotChecks })

describe("security eval scoring", () => {
	it("takes a bug's verdict from the strongest matched record", () => {
		const findings = [
			needsValidation("nv", "src/a.ts", ["deploy config unknown"]),
			rejected("rj", "src/a.ts"),
		]
		const run = scoreRun(
			result("k", "typescript", ["b1"]),
			findings,
			grades([{ key: "k", bug: "b1", matched: ["rj", "nv"] }]),
		)
		expect(run.bugs[0]?.verdict).toBe("hit-needs-validation")
	})

	it("scores a bug seen only as a rejected record as a miss the validators dismissed", () => {
		const run = scoreRun(
			result("k", "typescript", ["b1"]),
			[rejected("rj", "src/a.ts")],
			grades([{ key: "k", bug: "b1", matched: ["rj"] }]),
		)
		expect(run.bugs[0]).toMatchObject({ verdict: "miss", missReason: "dismissed-by-validation" })
	})

	it("leaves an ungraded bug unscored and out of the hit rate", () => {
		const scored = scoreRun(
			result("k", "typescript", ["b1", "b2"]),
			[],
			grades([{ key: "k", bug: "b1", verdict: "miss" }]),
		)
		const [row] = aggregate([scored], () => "all")
		expect(row).toMatchObject({ bugs: 2, miss: 1, unscored: 1, hitRate: 0 })
	})

	it("counts unrelated records as the non-rejected ones no bug matched", () => {
		const findings = [
			needsValidation("bug", "src/a.ts", ["x"]),
			needsValidation("other", "src/c.ts", ["x"]),
			rejected("noise", "src/c.ts"),
		]
		const run = scoreRun(
			result("k", "typescript", ["b1"]),
			findings,
			grades([{ key: "k", bug: "b1", matched: ["bug"] }]),
		)
		expect(run.unrelated).toBe(1)
	})

	it("rolls bugs up per bug and cost up per run, by group", () => {
		const a = scoreRun(
			result("a", "typescript", ["a1", "a2"], 12),
			[],
			grades(
				[
					{ key: "a", bug: "a1", verdict: "hit-confirmed" },
					{ key: "a", bug: "a2", verdict: "wrong-location" },
				],
				[{ key: "a", fingerprint: "x", class: "false-positive" }],
			),
		)
		const b = scoreRun(
			result("b", "go", ["g1"], 8),
			[],
			grades([{ key: "b", bug: "g1", verdict: "hit-needs-validation" }]),
		)
		const rows = aggregate([a, b], (r) => r.language)
		expect(rows.map((r) => [r.group, r.runs, r.bugs, r.hitRate, r.costUsd, r.spotFalsePositive])).toEqual(
			[
				["go", 1, 1, 1, 8, 0],
				["typescript", 1, 2, 0.5, 12, 1],
			],
		)
	})

	it("suggests only records that touch a non-test file the fix changed", () => {
		const bug = { id: "b", reference: "#1", fixSha: "f", touchedFiles: ["src/a.ts", "src/a.test.ts"] }
		const matches = locationMatches(
			[needsValidation("hit", "./src/a.ts", ["x"]), needsValidation("test", "src/a.test.ts", ["x"])],
			[bug],
		)
		expect(matches.map((m) => m.fingerprint)).toEqual(["hit"])
	})

	it("treats a record as execution-bound only when every blocker is about running code", () => {
		expect(isExecutionOnly(needsValidation("a", "f", ["No sandbox to execute the PoC"]))).toBe(true)
		expect(
			isExecutionOnly(
				needsValidation("b", "f", ["No sandbox to execute", "production routing is unknown"]),
			),
		).toBe(false)
	})

	it("sums agent usage from run events, counting failed and discarded invocations", () => {
		const m = metricsOf({
			status: "complete",
			wallClockSeconds: 1,
			findings: [],
			events: [
				{
					_tag: "Agent",
					at: "t",
					outcome: "ok",
					usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.5 },
				},
				{
					_tag: "Agent",
					at: "t",
					outcome: "discarded",
					usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.25 },
				},
				{ _tag: "Agent", at: "t", outcome: "failed" },
				{ _tag: "Phase", at: "t" },
			],
		})
		expect(m).toMatchObject({
			invocations: 3,
			agentsFailed: 1,
			inputTokens: 15,
			outputTokens: 3,
			costUsd: 0.75,
		})
	})

	it("estimates a run from observed spend per invocation and refuses one over the cap", () => {
		const estimate = estimateCost(20, [metrics(15, 10), metrics(5, 10)], 99)
		expect(estimate).toBe(20)
		expect(fitsCap(235, estimate, 250)).toBe(false)
		expect(estimateCost(10, [], 1.5)).toBe(15)
	})

	it("refuses a hit grade that names no matched record, so its record is never counted unrelated", () => {
		expect(() =>
			decodeGrades({ bugs: [{ key: "k", bug: "b", verdict: "hit-confirmed" }], spotChecks: [] }),
		).toThrow(/matched record fingerprints/)
		expect(
			decodeGrades({ bugs: [{ key: "k", bug: "b", verdict: "miss" }], spotChecks: [] }).bugs[0]
				?.verdict,
		).toBe("miss")
	})

	it("matches execution blockers on whole words only", () => {
		expect(
			isExecutionOnly(needsValidation("a", "f", ["Epoch handling in the deployment is unknown"])),
		).toBe(false)
		expect(isExecutionOnly(needsValidation("b", "f", ["Nothing was executed; no PoC ran"]))).toBe(true)
	})

	it("skips a half-written last event line instead of failing", () => {
		const text = `${JSON.stringify({ _tag: "Agent", at: "t", outcome: "ok", usage: { inputTokens: 1, outputTokens: 1, costUsd: 2 } })}\n{"_tag":"Agent","at":`
		expect(parseEventLines(text)).toHaveLength(1)
	})

	it("refuses a case whose commit, repository name or url could reach git as an option or path", () => {
		const file = (repo: { name: string; url: string }, sha: string) => ({
			defaults: { profile: "quick", budget: 10, concurrency: 1 },
			cases: [
				{
					id: "c",
					corpus: "public",
					language: "go",
					repo,
					sha,
					scope: [],
					bugs: [{ id: "b", reference: "r", fixSha: "a".repeat(40), touchedFiles: [] }],
				},
			],
		})
		const ok = { name: "ws", url: "https://github.com/websockets/ws.git" }
		expect(decodeCaseFile(file(ok, "a".repeat(40))).cases).toHaveLength(1)
		expect(() => decodeCaseFile(file(ok, "--upload-pack=x"))).toThrow()
		expect(() => decodeCaseFile(file({ ...ok, name: ".." }, "a".repeat(40)))).toThrow()
		expect(() => decodeCaseFile(file({ ...ok, url: "ext::sh -c id" }, "a".repeat(40)))).toThrow()
	})
})
