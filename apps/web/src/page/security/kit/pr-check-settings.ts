import { SecurityAuditTarget, SecurityAuditUpdateTargetRequest } from "@maple/domain/http"
import { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Effect, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import type { Resources } from "../../../platform/resources"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Select from "@maple/views/ui/select"
import * as Switch from "@maple/views/ui/switch"
import { updateTarget } from "./api"
import { PR_CHECK_BLOCK_LABEL, type PrCheckBlockChoice, prCheckBlockAtOf, prCheckChoiceOf } from "./format"

// The pull request check dialog: whether a target checks pull requests into its branch, and what fails the check.

export const DIALOG_ID = "security-pr-check-settings"

/** The select's rows, strictest first. */
export const BLOCK_CHOICES: ReadonlyArray<PrCheckBlockChoice> = [
	"critical",
	"high",
	"medium",
	"low",
	"report",
]

const isChoice = (value: string): value is PrCheckBlockChoice => value in PR_CHECK_BLOCK_LABEL

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	/** The target the dialog opened on; null before the first open. */
	target: Schema.NullOr(SecurityAuditTarget),
	enabled: Switch.Model,
	blockAt: Select.Model,
	copy: CopyButton.Model,
	isPending: Schema.Boolean,
	/** Bumped each time the form opens: an answer for an earlier attempt is dropped. */
	attempt: Schema.Finite,
	failure: Schema.NullOr(LoadFailure),
})
export type Model = typeof Model.Type

const selectFor = (choice: PrCheckBlockChoice): Select.Model =>
	Select.init(`${DIALOG_ID}-block-at`, { value: choice, selectedIndex: BLOCK_CHOICES.indexOf(choice) })

export const init = (): Model => ({
	dialog: Dialog.init(DIALOG_ID, "dialog"),
	target: null,
	enabled: Switch.init(false),
	blockAt: selectFor("high"),
	copy: CopyButton.init(),
	isPending: false,
	attempt: 0,
	failure: null,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotEnabledMessage: { message: Switch.Message },
	GotBlockAtMessage: { message: Select.Message },
	GotCopyMessage: { message: CopyButton.Message },
	Submitted: {},
	CompletedSave: { attempt: Schema.Finite, result: Schema.Result(SecurityAuditTarget, LoadFailure) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	Saved: { target: SecurityAuditTarget },
})
export type OutMessage = typeof OutMessage.Type

export const SaveSecurityPrCheck = Command.define("SecurityApiUpdateTarget", {
	args: {
		attempt: Schema.Finite,
		targetId: SecurityAuditTargetId,
		payload: SecurityAuditUpdateTargetRequest,
	},
	messages: [Message.CompletedSave],
	execute: ({ attempt, targetId, payload }) =>
		Effect.map(updateTarget(targetId, payload), (result) => Message.CompletedSave({ attempt, result })),
})

/** What Save sends: the switch and the picked threshold. */
export const requestOf = (model: Model): Required<SecurityAuditUpdateTargetRequest> => ({
	prCheckEnabled: model.enabled.isChecked,
	prCheckBlockAt: prCheckBlockAtOf(isChoice(model.blockAt.value) ? model.blockAt.value : "high"),
})

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const DISMISSALS: ReadonlySet<string> = new Set(["ClickedClose", "PressedEscape", "PressedOutside"])

const dialogCommands = (commands: ReadonlyArray<Command.Command<Dialog.Message>> | undefined) =>
	Command.mapMessages(commands ?? [], (message) => Message.GotDialogMessage({ message }))

/** Opening fills the form from the target, so it never shows a previous attempt. */
export const open = (model: Model, target: SecurityAuditTarget): Return => {
	const step = Dialog.open(model.dialog)
	return {
		model: {
			...init(),
			dialog: step.model,
			target,
			enabled: Switch.init(target.prCheckEnabled),
			blockAt: selectFor(prCheckChoiceOf(target.prCheckBlockAt)),
			attempt: model.attempt + 1,
		},
		commands: dialogCommands(step.commands),
	}
}

const close = (model: Model): Return => {
	const step = Dialog.close(model.dialog)
	return {
		model: { ...model, dialog: step.model, isPending: false },
		commands: dialogCommands(step.commands),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: inner }) => {
			// A save in flight keeps the dialog: the answer has a form to land in.
			if (model.isPending && DISMISSALS.has(inner._tag)) return { model }
			const step = Dialog.update(model.dialog, inner)
			return { model: { ...model, dialog: step.model }, commands: dialogCommands(step.commands) }
		},
		GotEnabledMessage: ({ message: inner }) => ({
			model: { ...model, enabled: Switch.update(model.enabled, inner).model, failure: null },
		}),
		GotBlockAtMessage: ({ message: inner }) => {
			const step = Select.update(model.blockAt, inner)
			const picked = step.outMessage
			return {
				model: {
					...model,
					blockAt: picked === undefined ? step.model : { ...step.model, value: picked.value },
					failure: null,
				},
				commands: Command.mapMessages(step.commands ?? [], (next) =>
					Message.GotBlockAtMessage({ message: next }),
				),
			}
		},
		GotCopyMessage: ({ message: inner }) => {
			const step = CopyButton.update(model.copy, inner)
			return {
				model: { ...model, copy: step.model },
				commands: Command.mapMessages(step.commands ?? [], (next) =>
					Message.GotCopyMessage({ message: next }),
				),
			}
		},
		Submitted: () => {
			if (model.isPending || model.target === null) return { model }
			return {
				model: { ...model, isPending: true, failure: null },
				commands: [
					SaveSecurityPrCheck({
						attempt: model.attempt,
						targetId: model.target.id,
						payload: requestOf(model),
					}),
				],
			}
		},
		CompletedSave: ({ attempt, result }) =>
			attempt !== model.attempt || !model.isPending
				? { model }
				: Result.match(result, {
						onFailure: (failure) => ({ model: { ...model, isPending: false, failure } }),
						onSuccess: (target) => ({
							...close({ ...model, target }),
							outMessage: OutMessage.Saved({ target }),
						}),
					}),
	})
