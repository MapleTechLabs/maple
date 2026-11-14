import { AlertRuleId } from "@maple/domain/http"
import { Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { fetchSessionGrants } from "../../kit/session-grants"
import { deleteDetection, listDetections, updateDetection } from "../kit/detection-api"
import { Message } from "./model"

// The Detections page's reads and writes. Names start with `SecurityApi` (and the session's with
// `ReadSecurity`) so the lab drops them.

export const ReadDetectionsGrants = fetchSessionGrants(
	"ReadSecurityDetectionsGrants",
	Message.CompletedReadGrants,
)

export const FetchDetections = Command.define("SecurityApiDetectionsList", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchDetections],
	execute: ({ key }) =>
		listDetections.pipe(settleTo((result) => Message.CompletedFetchDetections({ key, result }))),
})

/** Turns one detection on or off; the answer is the detection as the API stored it. */
export const SaveDetectionEnabled = Command.define("SecurityApiDetectionToggle", {
	args: { id: AlertRuleId, enabled: Schema.Boolean },
	messages: [Message.CompletedToggle],
	execute: ({ id, enabled }) =>
		updateDetection(id, { enabled }).pipe(settleTo((result) => Message.CompletedToggle({ id, result }))),
})

export const DeleteDetection = Command.define("SecurityApiDetectionDelete", {
	args: { id: AlertRuleId },
	messages: [Message.CompletedDelete],
	execute: ({ id }) =>
		deleteDetection(id).pipe(settleTo((result) => Message.CompletedDelete({ id, result }))),
})
