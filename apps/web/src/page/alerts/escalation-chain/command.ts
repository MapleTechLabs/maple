import { EscalationChainId } from "@maple/domain/http"
import { V2EscalationChainCreateParams } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { Command, Dom } from "foldkit"
import { fetchSessionGrants } from "../../kit/session-grants"
import {
	deleteEscalationChain,
	retrieveEscalationChain,
	saveEscalationChain,
} from "../shared/escalation-chains"
import { listOnCallSchedules } from "../shared/oncall-schedules"
import { listOrgMembers } from "../shared/org-members"
import { Message } from "./message"

export const FetchExistingChain = Command.define("FetchEscalationChainEditorChain", {
	args: { key: Schema.String, chainId: EscalationChainId },
	messages: [Message.CompletedFetchExisting],
	execute: ({ key, chainId }) =>
		retrieveEscalationChain(chainId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchExisting({ key, result })),
		),
})

export const FetchChainEditorMembers = Command.define("FetchEscalationChainEditorMembers", {
	messages: [Message.CompletedFetchMembers],
	execute: listOrgMembers.pipe(
		Effect.result,
		Effect.map((result) => Message.CompletedFetchMembers({ result })),
	),
})

export const FetchChainEditorSchedules = Command.define("FetchEscalationChainEditorSchedules", {
	messages: [Message.CompletedFetchSchedules],
	execute: listOnCallSchedules.pipe(
		Effect.result,
		Effect.map((result) => Message.CompletedFetchSchedules({ result })),
	),
})

export const FetchChainEditorSession = fetchSessionGrants(
	"FetchEscalationChainEditorSession",
	Message.CompletedFetchSession,
)

export const SaveChain = Command.define("SaveEscalationChainFromEditor", {
	args: { editingId: Schema.NullOr(EscalationChainId), payload: V2EscalationChainCreateParams },
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		saveEscalationChain(editingId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ result })),
		),
})

export const DeleteChain = Command.define("DeleteEscalationChainFromEditor", {
	args: { chainId: EscalationChainId },
	messages: [Message.CompletedDelete],
	execute: ({ chainId }) =>
		deleteEscalationChain(chainId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDelete({ result })),
		),
})

/** Moves focus after a step edit, to an element by id once it is on the page. */
export const FocusChainElement = Command.define("FocusEscalationChainElement", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocus],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocus())),
})
