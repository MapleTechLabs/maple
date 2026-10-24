/**
 * Phase 6: `REPORT.md`, `FINDINGS-DETAIL.md` and `NEEDS-VALIDATION.md`, derived only from the final
 * records and the ledger. Prose never changes a verdict, severity, blocker or impact.
 */
import type { Finding } from "../schema"
import type { LedgerUnit } from "./ledger"
import type { AuditReports } from "./ports"
import type { AuditRunInput, EngineState } from "./state"

type Confirmed = Extract<Finding, { readonly verdict: "confirmed" }>
type NeedsValidation = Extract<Finding, { readonly verdict: "needs_validation" }>

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "informational"] as const

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ")

const traceLines = (record: Finding) =>
	record.trace
		.map((step) => `- ${step.kind}: \`${step.file}:${step.line}\` (${step.scope}) ${step.description}`)
		.join("\n")

const boundaryOf = (ledger: ReadonlyArray<LedgerUnit>, fingerprint: string) =>
	ledger.find((unit) => unit.result_fingerprints.includes(fingerprint))?.boundary ?? "not linked to a unit"

const countBy = (ledger: ReadonlyArray<LedgerUnit>) =>
	ledger.reduce<Record<string, number>>(
		(acc, unit) => ({ ...acc, [unit.status]: (acc[unit.status] ?? 0) + 1 }),
		{},
	)

const confirmedDetail = (record: Confirmed) =>
	[
		`### ${record.title}`,
		`Severity: **${record.severity.overall_severity}** (likelihood ${record.severity.likelihood.score}: ${record.severity.likelihood.reason}; impact ${record.severity.impact.score}: ${record.severity.impact.reason}). Confidence: ${record.confidence.score} (${record.confidence.reason}).`,
		`Lower-trust principal: ${record.execution.attacker_perspective}`,
		`Root cause: ${record.root_cause}\n\nIntended behavior: ${record.intended_behavior}`,
		`Trace:\n${traceLines(record)}`,
		`Conditions:\n${record.conditions.map((c) => `- ${c.kind}: ${c.description}`).join("\n") || "- none"}`,
		`Bounded reproduction:\n${record.execution.instructions.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\nInputs:\n${record.execution.payloads.map((p) => `- \`${cell(p)}\``).join("\n")}`,
		`Observed result: ${record.execution.observed_result}`,
		`Smallest fix: ${record.remediation.strategy}`,
	].join("\n\n")

const needsValidationDetail = (record: NeedsValidation) =>
	[
		`### ${record.title}`,
		`Claimed root cause: ${record.claimed_root_cause}`,
		`Trace:\n${traceLines(record)}`,
		`Evidence:\n${record.evidence.map((e) => `- \`${e.file}:${e.line}\` ${e.description}`).join("\n")}`,
		`Blockers:\n${record.blockers.map((b) => `- ${b}`).join("\n")}`,
		...(record.validation_plan.local === undefined
			? []
			: [`Local next step: ${record.validation_plan.local}`]),
		...(record.validation_plan.deployment === undefined
			? []
			: [`Owner-observed check: ${record.validation_plan.deployment}`]),
	].join("\n\n")

export const buildReports = (
	input: AuditRunInput,
	s: EngineState,
	findings: ReadonlyArray<Finding>,
	status: "complete" | "incomplete",
): AuditReports => {
	const confirmed = findings
		.filter((f): f is Confirmed => f.verdict === "confirmed")
		.sort(
			(a, b) =>
				SEVERITY_ORDER.indexOf(a.severity.overall_severity) -
				SEVERITY_ORDER.indexOf(b.severity.overall_severity),
		)
	const pending = findings.filter((f): f is NeedsValidation => f.verdict === "needs_validation")
	const counts = countBy(s.ledger)
	const unvalidated = [
		...new Set([...s.candidates.keys(), ...s.carried.map((c) => c.record.fingerprint)]),
	].filter((fp) => !s.findings.has(fp))
	const partial =
		input.profile === "quick" ||
		input.scopePaths.length > 0 ||
		s.gaps.length > 0 ||
		status === "incomplete"
	const deferred = s.ledger.filter((u) => u.status === "deferred")
	const outOfScope = s.ledger.filter((u) => u.status === "out_of_scope")
	const carried = s.ledger.filter((u) => u.prior_status === "prior_confirmed_same_source").length
	const revalidated = s.ledger.filter((u) => u.prior_status === "prior_confirmed_changed_source").length
	const hardening = [...new Set(s.ledger.flatMap((u) => u.hardening ?? []))]

	const run = [
		"## Run",
		`- Profile: ${input.profile}. Scope: ${input.scopePaths.length === 0 ? "whole repository" : input.scopePaths.join(", ")}. Source ref: \`${input.sourceRef}\`.`,
		`- Budget: ${input.budget === null ? "none set" : `${input.budget} agent invocations`}; spent ${s.spent}.`,
		`- Execution: sandboxed source-and-local-only. ${input.execution._tag === "Available" ? `Bounded local checks were available (${input.execution.limits}).` : `No target code was executed: ${input.execution.blocker}.`}`,
		`- Prior runs: ${input.prior === null ? "none; this run had no prior ledger" : `${input.prior.runId} at \`${input.prior.sourceRef}\`; ${carried} same-source confirmations carried for re-verification, ${revalidated} changed-source revalidations`}.`,
		`- Status: **${status}**${s.incomplete.length === 0 ? "" : ` (${s.incomplete.join("; ")})`}.${partial ? " This is a partial pass." : ""}`,
		...(unvalidated.length === 0
			? []
			: [
					`- Candidates without an independent verdict (not findings): ${unvalidated.map((fp) => `\`${fp}\``).join(", ")}.`,
				]),
		`- Coverage critic: ${s.criticClean ? "the final-clean critic accepted no further work" : "no clean-coverage claim"}.`,
		...(s.gaps.length === 0 ? [] : [`- Disclosed gaps: ${s.gaps.join("; ")}.`]),
	].join("\n")

	const posture = `## Posture\n\n${confirmed.length} confirmed ${confirmed.length === 1 ? "vulnerability" : "vulnerabilities"}${
		confirmed.length === 0
			? ""
			: ` (${SEVERITY_ORDER.map(
					(sev) =>
						[sev, confirmed.filter((f) => f.severity.overall_severity === sev).length] as const,
				)
					.filter(([, n]) => n > 0)
					.map(([sev, n]) => `${n} ${sev}`)
					.join(", ")})`
	} and ${pending.length} ${pending.length === 1 ? "lead" : "leads"} needing validation.`

	const table =
		confirmed.length === 0
			? "## Confirmed findings\n\nNone confirmed in this run."
			: `## Confirmed findings\n\n| Severity | Title | Boundary | Observed result |\n| --- | --- | --- | --- |\n${confirmed
					.map(
						(f) =>
							`| ${f.severity.overall_severity} | ${cell(f.title)} | ${cell(boundaryOf(s.ledger, f.fingerprint))} | ${cell(f.execution.observed_result)} |`,
					)
					.join("\n")}\n\n${confirmed.map(confirmedDetail).join("\n\n")}`

	const needsTable =
		pending.length === 0
			? "## NEEDS VALIDATION\n\nNone."
			: `## NEEDS VALIDATION\n\n| Title | Entry | Blocker | Local next step | Owner check |\n| --- | --- | --- | --- | --- |\n${pending
					.map(
						(f) =>
							`| ${cell(f.title)} | \`${f.trace[0]?.file ?? ""}:${f.trace[0]?.line ?? ""}\` | ${cell(f.blockers.join("; "))} | ${cell(f.validation_plan.local ?? "-")} | ${cell(f.validation_plan.deployment ?? "-")} |`,
					)
					.join("\n")}`

	const notes = `## Hardening notes\n\n${hardening.length === 0 ? "None recorded." : hardening.map((h) => `- ${h}`).join("\n")}`

	const coverage = [
		"## Coverage",
		Object.entries(counts)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([status, n]) => `- ${status}: ${n}`)
			.join("\n"),
		...(deferred.length === 0
			? []
			: [
					`Deferred units:\n${deferred.map((u) => `- ${u.surface} / ${u.attack_class}: ${u.unresolved.join("; ")}`).join("\n")}`,
				]),
		...(outOfScope.length === 0
			? []
			: [`Out of scope: ${outOfScope.length} units recorded for later runs.`]),
	].join("\n\n")

	const report = [`# Security audit: ${input.repo}`, run, posture, table, needsTable, notes, coverage].join(
		"\n\n",
	)
	const detailed = confirmed.filter((f) =>
		["critical", "high", "medium"].includes(f.severity.overall_severity),
	)
	const findingsDetail = `# Findings detail\n\n${detailed.length === 0 ? "No confirmed medium, high or critical findings." : detailed.map(confirmedDetail).join("\n\n")}`
	const needsValidation = `# Needs validation\n\n${pending.length === 0 ? "No unresolved leads." : pending.map(needsValidationDetail).join("\n\n")}`
	return { report, findingsDetail, needsValidation }
}
