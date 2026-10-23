/**
 * One audit run, all six phases in the skill's order. It ends in exactly one of the skill's two
 * terminal states: every artifact written with both validators passing (`complete`), or
 * `incomplete` with its reasons recorded and disclosed in the report.
 */
import { Effect, Ref } from "effect"
import type { Finding } from "../schema"
import { findingsErrors, ledgerErrors } from "../validators"
import type { LedgerUnit } from "./ledger"
import type { AuditReports, RunMetadata, RunStatus } from "./ports"
import { runReconnaissance } from "./recon"
import { runHunting } from "./hunt"
import { buildReports } from "./report"
import { type AuditRunInput, type EngineState, makeEngine } from "./state"
import { finalFindings, runCandidateValidation, runRecordVerification } from "./validate"

export interface AuditRunResult {
	readonly status: Exclude<RunStatus, "in_progress">
	readonly incompleteReasons: ReadonlyArray<string>
	readonly gaps: ReadonlyArray<string>
	readonly ledger: ReadonlyArray<LedgerUnit>
	readonly findings: ReadonlyArray<Finding>
	readonly reports: AuditReports
	readonly invocations: number
}

const metadata = (input: AuditRunInput, status: RunStatus, reasons: ReadonlyArray<string>): RunMetadata => {
	const base: RunMetadata = {
		run_id: input.runId,
		repo: input.repo,
		target: input.target,
		source_ref: input.sourceRef,
		profile: input.profile,
		scope_paths: input.scopePaths,
		budget: input.budget,
		execution_policy: "sandboxed-source-and-local-only",
		execution: input.execution,
		prior_runs: input.prior === null ? [] : [input.prior.runId],
		run_status: status,
	}
	return reasons.length === 0 ? base : { ...base, incomplete_reason: reasons.join("; ") }
}

/** Final records: decided findings plus unchanged prior rejections a hunter re-raised. */
const assembleFindings = (s: EngineState): ReadonlyArray<Finding> => {
	const decided = finalFindings(s)
	const raised = new Set(s.ledger.flatMap((unit) => unit.result_fingerprints))
	const suppressed = [...s.suppressed.values()].filter(
		(record) => raised.has(record.fingerprint) && !s.findings.has(record.fingerprint),
	)
	return [...decided, ...suppressed].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))
}

export const runAudit = (input: AuditRunInput) =>
	Effect.gen(function* () {
		const engine = yield* makeEngine(input)
		yield* engine.store.saveMetadata(metadata(input, "in_progress", []))

		if (yield* runReconnaissance(engine)) {
			yield* runHunting(engine)
			yield* runCandidateValidation(engine)
			yield* runRecordVerification(engine)
		}

		const s = yield* Ref.get(engine.state)
		const findings = assembleFindings(s)
		const findingErrors = findingsErrors(findings)
		const ledgerProblems = ledgerErrors(s.ledger)
		if (findingErrors.length > 0)
			yield* engine.fail(`findings_failed_validation: ${findingErrors.slice(0, 3).join("; ")}`)
		if (ledgerProblems.length > 0)
			yield* engine.fail(`ledger_failed_validation: ${ledgerProblems.slice(0, 3).join("; ")}`)

		const final = yield* Ref.get(engine.state)
		const status = final.incomplete.length === 0 ? "complete" : "incomplete"
		const reports = buildReports(input, final, findings, status)
		yield* engine.store.saveFindings(input.runId, findingErrors.length === 0 ? findings : [])
		yield* engine.store.saveReports(input.runId, reports)
		yield* engine.store.saveMetadata(metadata(input, status, final.incomplete))
		yield* engine.event({
			_tag: "Phase",
			phase: "finished",
			detail: `${status}, ${final.spent} invocations`,
		})
		return {
			status,
			incompleteReasons: final.incomplete,
			gaps: final.gaps,
			ledger: final.ledger,
			findings,
			reports,
			invocations: final.spent,
		} satisfies AuditRunResult
	})
