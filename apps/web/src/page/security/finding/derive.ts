import type {
	SecurityAuditFinding,
	SecurityAuditFindingTriageStatus,
	SecurityAuditTarget,
} from "@maple/domain/http"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Model } from "./model"
import {
	currentTriageOf as currentStatusTriage,
	pickedTriageOf as pickedStatusTriage,
} from "../kit/triage-form"

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
	currentStatusTriage(finding.status)

export const pickedTriageOf = (
	model: Model,
	finding: SecurityAuditFinding,
): SecurityAuditFindingTriageStatus => pickedStatusTriage(model.triage, finding.status)
