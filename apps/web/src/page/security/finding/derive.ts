import type {
	SecurityAuditFinding,
	SecurityAuditFindingTriageStatus,
	SecurityAuditTarget,
} from "@maple/domain/http"
import { Option, String as Str, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Model } from "./model"

// The finding the route names, and what the triage form would send.

export const findingOf = (model: Model): SecurityAuditFinding | null =>
	Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.findings.data), (data) =>
			Arr.findFirst(data.findings, (finding) => finding.fingerprint === model.fingerprint),
		),
	)

export const targetOf = (model: Model): SecurityAuditTarget | null =>
	Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.targets.data), (data) =>
			Arr.findFirst(data.targets, (target) => target.id === model.targetId),
		),
	)

/** `fixed` is the engine's; a person triages a fixed finding as if it were open. */
export const currentTriageOf = (finding: SecurityAuditFinding): SecurityAuditFindingTriageStatus =>
	finding.status === "fixed" ? "open" : finding.status

export const pickedTriageOf = (
	model: Model,
	finding: SecurityAuditFinding,
): SecurityAuditFindingTriageStatus =>
	Option.getOrElse(
		Arr.findFirst(TRIAGE_STATUSES, (status) => status === model.triage.values[0]),
		() => currentTriageOf(finding),
	)

export const TRIAGE_STATUSES: ReadonlyArray<SecurityAuditFindingTriageStatus> = [
	"open",
	"dismissed",
	"accepted_risk",
]

const REASON_MAX = 2000

export const reasonErrorOf = (reason: string): string | null =>
	Str.trim(reason) === ""
		? "A reason is required. It is recorded in the org audit log with your name."
		: Str.trim(reason).length > REASON_MAX
			? `Keep the reason under ${REASON_MAX} characters.`
			: null
