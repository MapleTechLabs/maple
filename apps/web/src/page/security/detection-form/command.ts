import { AlertRuleId, AuditDetectionCreateRequest } from "@maple/domain/http"
import { Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { fetchSessionGrants } from "../../kit/session-grants"
import { createDetection, listDetections, updateDetection } from "../kit/detection-api"
import { Message } from "./model"

// The detection editor's reads and its save. Names start with `SecurityApi` (and the session's
// with `ReadSecurity`) so the lab drops them.

export const ReadDetectionFormGrants = fetchSessionGrants(
	"ReadSecurityDetectionFormGrants",
	Message.CompletedReadGrants,
)

/** The org's detections: there is no read of one, and the list holds at most 50. */
export const FetchExistingDetection = Command.define("SecurityApiDetectionFormExisting", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchExisting],
	execute: ({ key }) =>
		listDetections.pipe(settleTo((result) => Message.CompletedFetchExisting({ key, result }))),
})

/** Creates the detection, or replaces the edited one's fields; the answer is what was stored. */
export const SaveDetection = Command.define("SecurityApiDetectionSave", {
	args: { editingId: Schema.NullOr(AlertRuleId), payload: AuditDetectionCreateRequest },
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		(editingId === null ? createDetection(payload) : updateDetection(editingId, payload)).pipe(
			settleTo((result) => Message.CompletedSave({ result })),
		),
})
