import type {
	SecurityAuditFinding,
	SecurityAuditFindingTriageStatus,
	SecurityAuditTarget,
} from "@maple/domain/http"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Model } from "./model"

// The finding the route names, and what the triage form would send.

export const findingOf = (model: Model): SecurityAuditFinding | null =>
	Option.getOrNull(AsyncData.getData(model.findings.data))?.findings.find(
		(finding) => finding.fingerprint === model.fingerprint,
	) ?? null

export const targetOf = (model: Model): SecurityAuditTarget | null =>
	Option.getOrNull(AsyncData.getData(model.targets.data))?.targets.find(
		(target) => target.id === model.targetId,
	) ?? null

/** `fixed` is the engine's; a person triages a fixed finding as if it were open. */
export const currentTriageOf = (finding: SecurityAuditFinding): SecurityAuditFindingTriageStatus =>
	finding.status === "fixed" ? "open" : finding.status

export const pickedTriageOf = (
	model: Model,
	finding: SecurityAuditFinding,
): SecurityAuditFindingTriageStatus => model.triageStatus ?? currentTriageOf(finding)

export const REASON_MAX = 2000

export const reasonErrorOf = (reason: string): string | null =>
	reason.trim() === ""
		? "A reason is required. It is recorded in the org audit log with your name."
		: reason.trim().length > REASON_MAX
			? `Keep the reason under ${REASON_MAX} characters.`
			: null
