import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, String as Str } from "effect"
import type { Finding, Severity } from "@maple/security-audit"
import { type FindingLifecycle, prCheckVerdict, type PrCheckVerdictInput } from "./pr-check-verdict"

const confirmed = (fingerprint: string, severity: Severity, file = "src/keys.ts"): Finding => ({
	verdict: "confirmed",
	fingerprint,
	title: `Finding ${fingerprint}`,
	description: "rollKey looks the key up by id alone.",
	root_cause: "missing org predicate",
	intended_behavior: "scoped to the caller's org",
	trace: [
		{ kind: "entrypoint", file: "src/routes.ts", line: 10, scope: "POST /keys", description: "request" },
		{ kind: "sink", file, line: 42, scope: "rollKey", description: "unscoped lookup" },
	],
	evidence: [],
	conditions: [],
	execution: { attacker_perspective: "member", payloads: [], instructions: [], observed_result: "rolled" },
	remediation: { strategy: "filter by org" },
	severity: {
		likelihood: { score: "medium", reason: "needs an id" },
		impact: { score: severity, reason: "cross-tenant" },
		overall_severity: severity,
	},
	confidence: { score: "high", reason: "reproduced" },
})

const lead = (fingerprint: string): Finding => ({
	verdict: "needs_validation",
	fingerprint,
	title: `Lead ${fingerprint}`,
	description: "may be unscoped",
	trace: [],
	evidence: [{ file: "src/lead.ts", line: 3, description: "lookup" }],
	claimed_root_cause: "unchecked id",
	blockers: ["gateway config"],
	validation_plan: {},
})

const rejected = (fingerprint: string): Finding => ({
	verdict: "rejected",
	fingerprint,
	title: `Claim ${fingerprint}`,
	description: "claimed",
	trace: [],
	evidence: [],
	claimed_root_cause: "x",
	reason: "filtered upstream",
})

const verdictOf = (overrides: Partial<PrCheckVerdictInput>) =>
	prCheckVerdict({
		findings: [],
		lifecycle: new Map(),
		blockAt: "high",
		run: { status: "complete", incompleteReason: null, error: null },
		runUrl: "https://app.maple.dev/security/code/runs/r1",
		...overrides,
	})

const standings = (input: Partial<PrCheckVerdictInput>) =>
	Arr.map(verdictOf(input).findings, (f) => [f.finding.fingerprint, f.standing])

describe("prCheckVerdict", () => {
	it("fails on a confirmed finding at or above the threshold, and passes below it", () => {
		const findings = [
			confirmed("crit", "critical"),
			confirmed("high", "high"),
			confirmed("med", "medium"),
		]

		expect(verdictOf({ findings }).conclusion).toBe("failure")
		expect(verdictOf({ findings }).title).toBe("2 security issues block this merge")
		expect(standings({ findings })).toEqual([
			["crit", "blocking"],
			["high", "blocking"],
			["med", "reported"],
		])
		expect(verdictOf({ findings, blockAt: "critical" }).title).toBe("1 security issue blocks this merge")
		const medium = verdictOf({ findings: [confirmed("med", "medium")] })
		expect([medium.conclusion, medium.title]).toEqual([
			"success",
			"No blocking issues · 1 finding below the threshold",
		])
	})

	it("never fails when the target reports without a threshold, nor on leads or rejected claims", () => {
		expect(verdictOf({ findings: [confirmed("crit", "critical")], blockAt: null }).conclusion).toBe(
			"success",
		)
		const leads = verdictOf({ findings: [lead("l1"), rejected("r1")] })
		expect([leads.conclusion, Arr.map(leads.findings, (f) => f.standing)]).toEqual(["success", ["lead"]])
	})

	it("lets a dismissal, an accepted risk or a finding the branch's own audit reported through", () => {
		const lifecycle = new Map<string, FindingLifecycle>([
			["dismissed", { status: "dismissed", seenOnBranch: true }],
			["accepted", { status: "accepted_risk", seenOnBranch: false }],
			["branch", { status: "open", seenOnBranch: true }],
			// Reopened after a person triaged it on a pull request: the branch never had it, so it blocks.
			["reopened", { status: "open", seenOnBranch: false }],
			// Fixed on the branch and back in this pull request: a regression it brings.
			["regressed", { status: "fixed", seenOnBranch: true }],
		])
		const findings = Arr.map(["dismissed", "accepted", "branch", "reopened", "regressed"], (f) =>
			confirmed(f, "critical"),
		)

		expect(standings({ findings, lifecycle })).toEqual([
			["reopened", "blocking"],
			["regressed", "blocking"],
			["branch", "preexisting"],
			["dismissed", "accepted"],
			["accepted", "accepted"],
		])
	})

	it("fails open when the run could not finish, unless a confirmed blocker was already found", () => {
		const incomplete = {
			status: "incomplete" as const,
			incompleteReason: "budget exhausted",
			error: null,
		}
		const failed = { status: "failed" as const, incompleteReason: null, error: "sandbox unavailable" }

		const quiet = verdictOf({ run: incomplete, findings: [confirmed("med", "medium")] })
		expect([quiet.conclusion, quiet.title]).toEqual(["neutral", "Could not finish · not blocking"])
		expect(quiet.summary).toContain("budget exhausted")
		expect(verdictOf({ run: failed }).summary).toContain("the audit hit an error")
		expect(verdictOf({ run: failed }).summary).not.toContain("sandbox unavailable")
		expect(verdictOf({ run: incomplete, findings: [confirmed("crit", "critical")] }).conclusion).toBe(
			"failure",
		)
	})

	it("annotates each finding at its sink, and none for a dismissed one", () => {
		const lifecycle = new Map<string, FindingLifecycle>([
			["gone", { status: "dismissed", seenOnBranch: false }],
		])
		const { annotations } = verdictOf({
			findings: [confirmed("crit", "critical", "src/a.ts"), confirmed("gone", "high"), lead("l1")],
			lifecycle,
		})

		expect(Arr.map(annotations, (a) => [a.path, a.startLine, a.level])).toEqual([
			["src/a.ts", 42, "failure"],
			["src/lead.ts", 3, "notice"],
		])
	})

	it("escapes table cells so a finding title cannot break the summary table", () => {
		const finding = { ...confirmed("pipe", "low"), title: "a | b\nc" }

		expect(verdictOf({ findings: [finding] }).summary).toContain("a \\| b c")
	})
})

describe("prCheckVerdict GitHub limits", () => {
	it("keeps annotation lines at 1 or more and titles within 255 characters", () => {
		const long = { ...confirmed("long", "critical"), title: Str.repeat(400)("x") }
		const atZero: Finding = {
			...confirmed("zero", "high"),
			trace: [{ kind: "sink", file: "src/z.ts", line: 0, scope: "z", description: "z" }],
		}
		const { annotations } = verdictOf({ findings: [long, atZero] })

		expect(Arr.map(annotations, (a) => [a.title.length <= 255, a.startLine])).toEqual([
			[true, 42],
			[true, 1],
		])
	})
})
