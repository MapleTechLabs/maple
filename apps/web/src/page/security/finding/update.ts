import { Option, Result } from "effect"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import type { AppRoute } from "../../../route"
import * as Field from "../../../ui/field"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { copyToast } from "../../kit/clipboard"
import { FINDING_STATUS_LABEL } from "../kit/format"
import {
	CopyFingerprint,
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
	Option.match(
		Keyed.requestFor(
			model.findings,
			requestKey(context.orgId, "securityAudit.listFindings", { targetId: model.targetId }),
			mode,
		),
		{
			onNone: () => ({ model }),
			onSome: (findings) => ({
				model: { ...model, findings },
				commands: [FetchTargetFindings({ key: findings.key, targetId: model.targetId })],
			}),
		},
	)

export const init = (route: SecurityFindingRoute, context: PageContext): Return => {
	const model: Model = {
		targetId: route.targetId,
		fingerprint: route.fingerprint,
		nowMs: 0,
		isAdmin: !isClerkAuthEnabled,
		findings: Keyed.idle(),
		targets: Keyed.idle(),
		triageStatus: null,
		reason: Field.init(),
		isTriageSubmitted: false,
		isSaving: false,
	}
	const findingsKey = requestKey(context.orgId, "securityAudit.listFindings", { targetId: route.targetId })
	const targetsKey = requestKey(context.orgId, "securityAudit.listTargets", {})
	return {
		model: {
			...model,
			findings: Option.getOrElse(
				Keyed.request(model.findings, findingsKey, "Load"),
				() => model.findings,
			),
			targets: Option.getOrElse(Keyed.request(model.targets, targetsKey, "Load"), () => model.targets),
		},
		commands: [
			ReadFindingClock(),
			...(isClerkAuthEnabled ? [ReadFindingIsAdmin()] : []),
			FetchTargetFindings({ key: findingsKey, targetId: route.targetId }),
			FetchFindingTargets({ key: targetsKey }),
		],
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedReadIsAdmin: ({ isAdmin }) => ({ model: { ...model, isAdmin } }),
		CompletedFetchFindings: ({ key, result }) => ({
			model: { ...model, findings: Keyed.accept(model.findings, key, result) },
		}),
		CompletedFetchTargets: ({ key, result }) => ({
			model: { ...model, targets: Keyed.accept(model.targets, key, result) },
		}),
		ClickedRetry: () => readFindings(model, context, "Refresh"),
		PickedTriageStatus: ({ status }) => ({
			model: { ...model, triageStatus: status, isTriageSubmitted: false },
		}),
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
							triageStatus: null,
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
		ClickedCopyFingerprint: () => ({
			model,
			commands: [CopyFingerprint({ fingerprint: model.fingerprint })],
		}),
		CompletedCopy: ({ isOk }) => ({ model, outMessage: copyToast("Fingerprint", isOk) }),
	})
