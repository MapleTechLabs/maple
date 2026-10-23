import { Result } from "effect"
import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import type { AppRoute } from "../../../route"
import * as CopyButton from "../../../ui/copy-button"
import * as Field from "../../../ui/field"
import * as ToggleGroup from "../../../ui/toggle-group"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { chainAll, slotStep } from "../../kit/keyed-step"
import { FINDING_STATUS_LABEL } from "../kit/format"
import {
	FetchFindingTargets,
	FetchTargetFindings,
	ReadFindingClock,
	ReadFindingIsAdmin,
	UpdateFindingStatus,
} from "./command"
import { currentTriageOf, findingOf, pickedTriageOf, reasonErrorOf } from "./derive"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityFindingRoute = Extract<AppRoute, { readonly _tag: "SecurityFinding" }>

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const readFindings = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.findings,
		(findings) => ({ findings }),
		requestKey(context.orgId, "securityAudit.listFindings", { targetId: model.targetId }),
		mode,
		(key) => FetchTargetFindings({ key, targetId: model.targetId }),
	)

const readTargets = (model: Model, context: PageContext): Return =>
	slotStep(
		model,
		model.targets,
		(targets) => ({ targets }),
		requestKey(context.orgId, "securityAudit.listTargets", {}),
		"Load",
		(key) => FetchFindingTargets({ key }),
	)

const initTriage = (): ToggleGroup.Model => ToggleGroup.init({ label: "Status", values: [] })

export const init = (route: SecurityFindingRoute, context: PageContext): Return => {
	const model: Model = {
		targetId: route.targetId,
		fingerprint: route.fingerprint,
		nowMs: 0,
		isAdmin: !isClerkAuthEnabled,
		findings: Keyed.idle(),
		targets: Keyed.idle(),
		triage: initTriage(),
		copy: CopyButton.init(),
		reason: Field.init(),
		isTriageSubmitted: false,
		isSaving: false,
	}
	const loaded = chainAll(model, [
		(next) => readFindings(next, context, "Load"),
		(next) => readTargets(next, context),
	])
	return {
		...loaded,
		commands: [
			ReadFindingClock(),
			...(isClerkAuthEnabled ? [ReadFindingIsAdmin()] : []),
			...(loaded.commands ?? []),
		],
	}
}

/** The control shows the finding's status until someone picks another; a second click keeps it. */
const triageStep = (model: Model, message: ToggleGroup.Message): Return => {
	const step = ToggleGroup.update(model.triage, message)
	const finding = findingOf(model)
	const current = finding === null ? "open" : pickedTriageOf(model, finding)
	const values = step.model.values.length === 0 ? [current] : step.model.values
	return {
		model: { ...model, triage: { ...step.model, values }, isTriageSubmitted: false },
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotTriageMessage({ message: inner }),
		),
	}
}

/** Once the finding is in, the control starts on its status. */
const withTriage = (model: Model): Model => {
	const finding = findingOf(model)
	return finding === null || model.triage.values.length > 0
		? model
		: { ...model, triage: { ...model.triage, values: [currentTriageOf(finding)] } }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedReadIsAdmin: ({ isAdmin }) => ({ model: { ...model, isAdmin } }),
		CompletedFetchFindings: ({ key, result }) => ({
			model: withTriage({ ...model, findings: Keyed.accept(model.findings, key, result) }),
		}),
		CompletedFetchTargets: ({ key, result }) => ({
			model: { ...model, targets: Keyed.accept(model.targets, key, result) },
		}),
		ClickedRetry: () => readFindings(model, context, "Refresh"),
		GotTriageMessage: ({ message: inner }) => triageStep(model, inner),
		GotReasonMessage: ({ message: inner }) => ({
			model: { ...model, reason: Field.update(model.reason, inner).model },
		}),
		SubmittedTriage: () => {
			const finding = findingOf(model)
			if (finding === null || model.isSaving) return { model }
			const status = pickedTriageOf(model, finding)
			const reason = model.reason.value.trim()
			if (status === currentTriageOf(finding) && finding.status !== "fixed") return { model }
			if (reasonErrorOf(reason) !== null) return { model: { ...model, isTriageSubmitted: true } }
			return {
				model: { ...model, isTriageSubmitted: true, isSaving: true },
				commands: [
					UpdateFindingStatus({
						targetId: model.targetId,
						fingerprint: model.fingerprint,
						status,
						reason,
					}),
				],
			}
		},
		CompletedTriage: ({ result }) =>
			Result.match(result, {
				onSuccess: (triage) => {
					const refreshed = readFindings(
						{
							...model,
							isSaving: false,
							isTriageSubmitted: false,
							triage: initTriage(),
							reason: Field.init(),
						},
						context,
						"Supersede",
					)
					return {
						...refreshed,
						outMessage: toast(
							"success",
							`Marked ${FINDING_STATUS_LABEL[triage.status].toLowerCase()}`,
						),
					}
				},
				onFailure: (failure) => ({
					model: { ...model, isSaving: false },
					outMessage: toast("error", failure.title, failure.message),
				}),
			}),
		GotCopyMessage: ({ message: inner }) => {
			const step = CopyButton.update(model.copy, inner)
			return {
				model: { ...model, copy: step.model },
				commands: Command.mapMessages(step.commands ?? [], (next) =>
					Message.GotCopyMessage({ message: next }),
				),
			}
		},
	})
