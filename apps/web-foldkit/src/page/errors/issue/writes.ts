import { allowedTransitionsForAll, type IssueSeverity } from "@maple/domain/http"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import type { LoadFailure } from "../../../data/load-failure"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import { PageOutMessage, type PageReturn } from "../../contract"
import { WORKFLOW_LABEL } from "../kit/workflow"
import { EvaluateEscalation, RunIssueWrite } from "./command"
import { type IssueWrite, Message } from "./message"
import type { Model } from "./model"

// The rail's writes (`transitionTo`, `claim`, `heartbeat`, `release`, `changeSeverity` in the route).

type Return = PageReturn<Model, Message>
type Busy = Model["busy"][number]

const BUSY = {
	Transition: "state",
	Claim: "claim",
	Heartbeat: "heartbeat",
	Release: "release",
	SetSeverity: "severity",
} satisfies Readonly<Record<IssueWrite["_tag"], Busy>>

/** `useMutationAction`'s failure toast: the title, the error's user-facing message. */
const ERROR_TITLE = {
	Transition: "Failed to change state",
	Claim: "Failed to claim issue",
	Heartbeat: "Failed to extend lease",
	Release: "Failed to release issue",
	SetSeverity: "Failed to change severity",
} satisfies Readonly<Record<IssueWrite["_tag"], string>>

const successTitle = (write: IssueWrite, severity: string | null): string => {
	switch (write._tag) {
		case "Transition":
			return `Moved to ${WORKFLOW_LABEL[write.toState]}`
		case "Claim":
			return "Claimed"
		case "Heartbeat":
			return "Lease extended"
		case "Release":
			return "Released"
		case "SetSeverity":
			return severity === null ? "Severity cleared" : `Severity set to ${severity}`
	}
}

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

/** Starts a write unless the same kind is in flight; a severity write always goes (latest pick wins). */
export const startWrite = (model: Model, write: IssueWrite): Return => {
	const kind = BUSY[write._tag]
	return kind !== "severity" && model.busy.includes(kind)
		? { model }
		: {
				model: { ...model, busy: [...model.busy, kind] },
				commands: [RunIssueWrite({ issueId: model.issueId, write })],
			}
}

/** Drops one in-flight entry of the write's kind. */
const settledBusy = (busy: Model["busy"], kind: Busy): Model["busy"] => {
	const at = busy.indexOf(kind)
	return at === -1 ? busy : [...busy.slice(0, at), ...busy.slice(at + 1)]
}

const BUSY_PRIORITY: ReadonlyArray<Busy> = ["state", "severity", "heartbeat", "release", "claim"]

/** The sidebar's busy state: the first in-flight kind by its priority chain. */
export const sidebarBusy = (model: Model): Busy | null =>
	BUSY_PRIORITY.find((kind) => model.busy.includes(kind)) ?? null

const currentIssue = (model: Model) => Option.getOrNull(AsyncData.getData(model.detail.data))

/** `StateSelect`'s `change`: only a reachable state other than the current one moves the issue. */
export const pickedState = (model: Model, value: string): Return => {
	const issue = currentIssue(model)
	if (issue === null) return { model }
	const allowed = allowedTransitionsForAll([issue.workflow_state])
	const next = allowed.find((state) => state === value)
	return next === undefined || next === issue.workflow_state
		? { model }
		: startWrite(model, { _tag: "Transition", toState: next })
}

/** `changeSeverity`: clearing writes at once, a level asks the escalation policy first. */
export const pickedSeverity = (model: Model, severity: IssueSeverity | null): Return => {
	const picked = { ...model, severityPick: model.severityPick + 1 }
	return severity === null
		? startWrite(picked, { _tag: "SetSeverity", severity: null })
		: { model: picked, commands: [EvaluateEscalation({ severity, pick: picked.severityPick })] }
}

const liftConfirm = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, severityConfirm: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotSeverityConfirmMessage({ message }),
	),
})

export const evaluatedEscalation = (
	model: Model,
	severity: IssueSeverity,
	result: Result.Result<
		{ readonly outcome: string; readonly destinationIds: ReadonlyArray<string> },
		LoadFailure
	>,
): Return =>
	Result.match(result, {
		onFailure: () => ({
			model,
			outMessage: toast("error", "Could not evaluate the escalation policy. Severity was not changed."),
		}),
		onSuccess: (preview) => {
			if (preview.outcome !== "route") return startWrite(model, { _tag: "SetSeverity", severity })
			const names = preview.destinationIds.map(
				(id) => model.destinations.find((destination) => destination.id === id)?.name ?? id,
			)
			return liftConfirm(
				{ ...model, pendingSeverity: { severity, destinationNames: names } },
				Dialog.open(model.severityConfirm),
			)
		},
	})

/** "Change severity and notify": the dialog closes and the pending level is written. */
export const confirmedSeverity = (model: Model): Return => {
	const pending = model.pendingSeverity
	const closed = liftConfirm({ ...model, pendingSeverity: null }, Dialog.close(model.severityConfirm))
	if (pending === null) return closed
	const written = startWrite(closed.model, { _tag: "SetSeverity", severity: pending.severity })
	return { ...written, commands: [...(closed.commands ?? []), ...(written.commands ?? [])] }
}

/** Closing the dialog any other way drops the pending raise. */
export const severityConfirmStep = (model: Model, message: Dialog.Message): Return => {
	const step = Dialog.update(model.severityConfirm, message)
	const lifted = liftConfirm(model, step)
	return step.outMessage?._tag === "Closed"
		? { ...lifted, model: { ...lifted.model, pendingSeverity: null } }
		: lifted
}

/** The write's toast; `refresh` re-reads what the write invalidated. */
export const completedWrite = (
	model: Model,
	write: IssueWrite,
	result: Result.Result<{ readonly severity: string | null }, LoadFailure>,
	refresh: (model: Model) => {
		readonly model: Model
		readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>>
	},
): Return => {
	const settled = { ...model, busy: settledBusy(model.busy, BUSY[write._tag]) }
	return Result.match(result, {
		onFailure: (failure) => ({
			model: settled,
			outMessage: toast("error", ERROR_TITLE[write._tag], failure.message),
		}),
		onSuccess: ({ severity }) => {
			const refreshed = refresh(settled)
			return {
				model: refreshed.model,
				commands: refreshed.commands,
				outMessage: toast("success", successTitle(write, severity)),
			}
		},
	})
}
