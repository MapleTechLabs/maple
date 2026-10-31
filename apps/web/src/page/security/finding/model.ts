import {
	SecurityAuditFindingsResponse,
	SecurityAuditFindingTriageResult,
	SecurityAuditTargetsResponse,
} from "@maple/domain/http"
import { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Field from "../../../ui/field"
import * as ToggleGroup from "../../../ui/toggle-group"

// `/security/findings/$targetId/$fingerprint`: one finding with its triage.

export const Model = Schema.Struct({
	targetId: SecurityAuditTargetId,
	fingerprint: Schema.String,
	nowMs: Schema.Finite,
	isAdmin: Schema.Boolean,
	/** The target's findings; the page picks its own by fingerprint. */
	findings: KeyedSchema(SecurityAuditFindingsResponse, LoadFailure),
	targets: KeyedSchema(SecurityAuditTargetsResponse, LoadFailure),
	/** The triage control: the finding's own status until someone picks another. */
	triage: ToggleGroup.Model,
	copy: CopyButton.Model,
	reason: Field.Model,
	isTriageSubmitted: Schema.Boolean,
	isSaving: Schema.Boolean,
})
export type Model = typeof Model.Type

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedReadIsAdmin: { isAdmin: Schema.Boolean },
	CompletedFetchFindings: result(SecurityAuditFindingsResponse),
	CompletedFetchTargets: result(SecurityAuditTargetsResponse),
	ClickedRetry: {},
	GotTriageMessage: { message: ToggleGroup.Message },
	GotReasonMessage: { message: Field.Message },
	SubmittedTriage: {},
	CompletedTriage: { result: Schema.Result(SecurityAuditFindingTriageResult, LoadFailure) },
	GotCopyMessage: { message: CopyButton.Message },
})
export type Message = typeof Message.Type
