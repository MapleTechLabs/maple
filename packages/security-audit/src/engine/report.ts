/**
 * Phase 6: `REPORT.md`, `FINDINGS-DETAIL.md` and `NEEDS-VALIDATION.md`, derived only from the final
 * records and the ledger. Prose never changes a verdict, severity, blocker or impact.
 */
import { executionModeLine } from "../ecosystems"
import type { EstimatedSeverity, Finding } from "../schema"
import type { LedgerUnit } from "./ledger"
import type { AuditReports } from "./ports"
import type { AuditRunInput, EngineState } from "./state"
import { Array as Arr, Record as Rec, String as Str } from "effect"

type Confirmed = Extract<Finding, { readonly verdict: "confirmed" }>
type NeedsValidation = Extract<Finding, { readonly verdict: "needs_validation" }>

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "informational"] as const

/** Unit statuses that mean the run did not audit the unit. */
const UNFINISHED: ReadonlySet<string> = new Set([
	"planned",
	"in_progress",
	"blocked",
	"deferred",
	"out_of_scope",
])

const cell = (text: string) => Str.replaceAll("\n", " ")(Str.replaceAll("|", "\\|")(text))

const traceLines = (record: Finding) =>
	Arr.join(
		Arr.map(
			record.trace,
			(step) => `- ${step.kind}: \`${step.file}:${step.line}\` (${step.scope}) ${step.description}`,
		),
		"\n",
	)

const boundaryOf = (ledger: ReadonlyArray<LedgerUnit>, fingerprint: string) =>
	ledger.find((unit) => unit.result_fingerprints.includes(fingerprint))?.boundary ?? "not linked to a unit"

const countBy = (ledger: ReadonlyArray<LedgerUnit>) =>
	ledger.reduce<Record<string, number>>(
		(acc, unit) => ({ ...acc, [unit.status]: (acc[unit.status] ?? 0) + 1 }),
		{},
	)

const confirmedDetail = (record: Confirmed) =>
	Arr.join(
		[
			`### ${record.title}`,
			`Severity: **${record.severity.overall_severity}** (likelihood ${record.severity.likelihood.score}: ${record.severity.likelihood.reason}; impact ${record.severity.impact.score}: ${record.severity.impact.reason}). Confidence: ${record.confidence.score} (${record.confidence.reason}).`,
			`Lower-trust principal: ${record.execution.attacker_perspective}`,
			`Root cause: ${record.root_cause}\n\nIntended behavior: ${record.intended_behavior}`,
			`Trace:\n${traceLines(record)}`,
			`Conditions:\n${
				Arr.join(
					Arr.map(record.conditions, (c) => `- ${c.kind}: ${c.description}`),
					"\n",
				) || "- none"
			}`,
			`Bounded reproduction:\n${Arr.join(
				Arr.map(record.execution.instructions, (step, i) => `${i + 1}. ${step}`),
				"\n",
			)}\n\nInputs:\n${Arr.join(
				Arr.map(record.execution.payloads, (p) => `- \`${cell(p)}\``),
				"\n",
			)}`,
			`Observed result: ${record.execution.observed_result}`,
			`Smallest fix: ${record.remediation.strategy}`,
		],
		"\n\n",
	)

const needsValidationDetail = (record: NeedsValidation, estimate: EstimatedSeverity | undefined) =>
	Arr.join(
		[
			`### ${record.title}`,
			...(estimate === undefined
				? []
				: [
						`Estimated severity: ${estimate.overall_severity} (unverified; likelihood ${estimate.likelihood.score}: ${estimate.likelihood.reason}; impact ${estimate.impact.score}: ${estimate.impact.reason}).`,
					]),
			`Claimed root cause: ${record.claimed_root_cause}`,
			`Trace:\n${traceLines(record)}`,
			`Evidence:\n${Arr.join(
				Arr.map(record.evidence, (e) => `- \`${e.file}:${e.line}\` ${e.description}`),
				"\n",
			)}`,
			`Blockers:\n${Arr.join(
				Arr.map(record.blockers, (b) => `- ${b}`),
				"\n",
			)}`,
			...(record.validation_plan.local === undefined
				? []
				: [`Local next step: ${record.validation_plan.local}`]),
			...(record.validation_plan.deployment === undefined
				? []
				: [`Owner-observed check: ${record.validation_plan.deployment}`]),
		],
		"\n\n",
	)

export const buildReports = (
	input: AuditRunInput,
	s: EngineState,
	findings: ReadonlyArray<Finding>,
	status: "complete" | "incomplete",
): AuditReports => {
	const confirmed = Arr.filter(findings, (f): f is Confirmed => f.verdict === "confirmed").sort(
		(a, b) =>
			SEVERITY_ORDER.indexOf(a.severity.overall_severity) -
			SEVERITY_ORDER.indexOf(b.severity.overall_severity),
	)
	const pending = Arr.filter(findings, (f): f is NeedsValidation => f.verdict === "needs_validation")
	const modeLine =
		input.executionProfile === undefined ? undefined : executionModeLine(input.executionProfile)
	// Why execution-bound leads stay here: the run-level reason, beside each record's own blocker.
	const executionNote =
		modeLine === undefined || input.executionProfile?.mode !== "source_only"
			? ""
			: `${modeLine}. Leads whose deciding fact needs execution stay here.\n\n`
	const counts = countBy(s.ledger)
	const unvalidated = Arr.filter(
		[...new Set([...s.candidates.keys(), ...Arr.map(s.carried, (c) => c.record.fingerprint)])],
		(fp) => !s.findings.has(fp),
	)
	const partial =
		input.profile === "quick" ||
		input.scopePaths.length > 0 ||
		s.gaps.length > 0 ||
		status === "incomplete"
	const unfinished = Arr.filter(s.ledger, (u) => UNFINISHED.has(u.status))
	const carried = Arr.filter(s.ledger, (u) => u.prior_status === "prior_confirmed_same_source").length
	const revalidated = Arr.filter(
		s.ledger,
		(u) => u.prior_status === "prior_confirmed_changed_source",
	).length
	const hardening = [...new Set(Arr.flatMap(s.ledger, (u) => u.hardening ?? []))]

	const run = Arr.join(
		[
			"## Run",
			`- Profile: ${input.profile}. Scope: ${input.scopePaths.length === 0 ? "whole repository" : Arr.join(input.scopePaths, ", ")}. Source ref: \`${input.sourceRef}\`.`,
			`- Budget: ${input.budget === null ? "none set" : `${input.budget} agent invocations`}; spent ${s.spent}.`,
			`- Execution: sandboxed source-and-local-only. ${input.execution._tag === "Available" ? `Bounded local checks were available (${input.execution.limits}).` : `No target code was executed: ${input.execution.blocker}.`}`,
			...(modeLine === undefined ? [] : [`- ${modeLine}.`]),
			`- Prior runs: ${input.prior === null ? "none; this run had no prior ledger" : `${input.prior.runId} at \`${input.prior.sourceRef}\`; ${carried} same-source confirmations carried for re-verification, ${revalidated} changed-source revalidations`}.`,
			`- Status: **${status}**${s.incomplete.length === 0 ? "" : ` (${Arr.join(s.incomplete, "; ")})`}.${partial ? " This is a partial pass." : ""}`,
			...(unvalidated.length === 0
				? []
				: [
						`- Candidates without an independent verdict (not findings): ${Arr.join(
							Arr.map(unvalidated, (fp) => `\`${fp}\``),
							", ",
						)}.`,
					]),
			`- Coverage critic: ${s.criticClean ? "the final-clean critic accepted no further work" : "no clean-coverage claim"}.`,
			...(s.gaps.length === 0 ? [] : [`- Disclosed gaps: ${Arr.join(s.gaps, "; ")}.`]),
		],
		"\n",
	)

	const posture = `## Posture\n\n${confirmed.length} confirmed ${confirmed.length === 1 ? "vulnerability" : "vulnerabilities"}${
		confirmed.length === 0
			? ""
			: ` (${Arr.join(
					Arr.map(
						Arr.filter(
							Arr.map(
								SEVERITY_ORDER,
								(sev) =>
									[
										sev,
										Arr.filter(confirmed, (f) => f.severity.overall_severity === sev)
											.length,
									] as const,
							),
							([, n]) => n > 0,
						),
						([sev, n]) => `${n} ${sev}`,
					),
					", ",
				)})`
	} and ${pending.length} ${pending.length === 1 ? "lead" : "leads"} needing validation.`

	const table =
		confirmed.length === 0
			? "## Confirmed findings\n\nNone confirmed in this run."
			: `## Confirmed findings\n\n| Severity | Title | Boundary | Observed result |\n| --- | --- | --- | --- |\n${Arr.join(
					Arr.map(
						confirmed,
						(f) =>
							`| ${f.severity.overall_severity} | ${cell(f.title)} | ${cell(boundaryOf(s.ledger, f.fingerprint))} | ${cell(f.execution.observed_result)} |`,
					),
					"\n",
				)}\n\n${Arr.join(Arr.map(confirmed, confirmedDetail), "\n\n")}`

	const needsTable =
		pending.length === 0
			? `## NEEDS VALIDATION\n\n${executionNote}None.`
			: `## NEEDS VALIDATION\n\n${executionNote}| Title | Entry | Blocker | Local next step | Owner check |\n| --- | --- | --- | --- | --- |\n${Arr.join(
					Arr.map(
						pending,
						(f) =>
							`| ${cell(f.title)} | \`${f.trace[0]?.file ?? ""}:${f.trace[0]?.line ?? ""}\` | ${cell(Arr.join(f.blockers, "; "))} | ${cell(f.validation_plan.local ?? "-")} | ${cell(f.validation_plan.deployment ?? "-")} |`,
					),
					"\n",
				)}`

	const notes = `## Hardening notes\n\n${
		hardening.length === 0
			? "None recorded."
			: Arr.join(
					Arr.map(hardening, (h) => `- ${h}`),
					"\n",
				)
	}`

	const coverage = Arr.join(
		[
			"## Coverage",
			Arr.join(
				Arr.map(
					Rec.toEntries(counts).sort(([a], [b]) => (a < b ? -1 : 1)),
					([status, n]) => `- ${status}: ${n}`,
				),
				"\n",
			),
			// Never a silent cut: every unit this run did not finish is named, however many there are.
			...(unfinished.length === 0
				? []
				: [
						`Not covered by this run (${unfinished.length} ${unfinished.length === 1 ? "unit" : "units"}):\n${Arr.join(
							Arr.map(
								unfinished,
								(u) =>
									`- ${u.status}: ${u.surface} / ${u.attack_class}${u.unresolved.length === 0 ? "" : ` (${Arr.join(u.unresolved, "; ")})`}`,
							),
							"\n",
						)}`,
					]),
		],
		"\n\n",
	)

	const report = Arr.join(
		[`# Security audit: ${input.repo}`, run, posture, table, needsTable, notes, coverage],
		"\n\n",
	)
	const detailed = Arr.filter(confirmed, (f) =>
		["critical", "high", "medium"].includes(f.severity.overall_severity),
	)
	const findingsDetail = `# Findings detail\n\n${detailed.length === 0 ? "No confirmed medium, high or critical findings." : Arr.join(Arr.map(detailed, confirmedDetail), "\n\n")}`
	const needsValidation = `# Needs validation\n\n${executionNote}${
		pending.length === 0
			? "No unresolved leads."
			: Arr.join(
					Arr.map(pending, (f) => needsValidationDetail(f, s.estimates.get(f.fingerprint))),
					"\n\n",
				)
	}`
	return { report, findingsDetail, needsValidation }
}
