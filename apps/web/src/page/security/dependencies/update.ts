import type { DependencyFindingStatus, DependencyFindingTriageStatus } from "@maple/domain/dependency-scan"
import { Result } from "effect"
import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import type { AppRoute } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { chainAll, slotStep } from "../../kit/keyed-step"
import {
	FetchFindings,
	FetchRepositories,
	ReadDependenciesClock,
	ReadDependenciesIsAdmin,
	ScanRepository,
	UpdateFinding,
} from "./command"
import {
	isScanPending,
	reasonErrorOf,
	repositoriesOf,
	selectedFindingOf,
	settlePendingScans,
	STATUS_FILTER_LABEL,
	unexpiredScans,
} from "./derive"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityDependenciesRoute = Extract<AppRoute, { readonly _tag: "SecurityDependencies" }>

export const SHEET_ID = "security-dependency-finding"

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const readRepositories = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.repositories,
		(repositories) => ({ repositories }),
		requestKey(context.orgId, "dependencyScan.listRepositories", {}),
		mode,
		(key) => FetchRepositories({ key }),
	)

const readFindings = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.findings,
		(findings) => ({ findings }),
		requestKey(context.orgId, "dependencyScan.listFindings", {}),
		mode,
		(key) => FetchFindings({ key }),
	)

const readAll = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	chainAll(model, [
		(next) => readRepositories(next, context, mode),
		(next) => readFindings(next, context, mode),
	])

export const initialModel = (): Model => ({
	nowMs: 0,
	isAdmin: !isClerkAuthEnabled,
	repositories: Keyed.idle(),
	findings: Keyed.idle(),
	statusSelect: Select.init("security-dependency-status", { value: "open", selectedIndex: 0 }),
	repositorySelect: Select.init("security-dependency-repository", { value: "all", selectedIndex: 0 }),
	requestingScans: [],
	pendingScans: [],
	selectedId: null,
	sheet: Dialog.init(SHEET_ID, "sheet"),
	reason: Field.init(),
	isReasonSubmitted: false,
	savingStatus: null,
})

export const init = (_route: SecurityDependenciesRoute, context: PageContext): Return => {
	const loaded = readAll(initialModel(), context, "Load")
	return {
		...loaded,
		commands: [
			ReadDependenciesClock(),
			...(isClerkAuthEnabled ? [ReadDependenciesIsAdmin()] : []),
			...(loaded.commands ?? []),
		],
	}
}

const selectStep = (
	model: Model,
	select: Select.Model,
	message: Select.Message,
	write: (select: Select.Model) => Partial<Model>,
	wrap: (message: Select.Message) => Message,
): Return => {
	const next = Select.update(select, message)
	return {
		model: { ...model, ...write(next.model) },
		commands: Command.mapMessages(next.commands ?? [], wrap),
	}
}

const sheetStep = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, sheet: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotSheetMessage({ message })),
})

/** A finished scan changes the findings, so they are read again. */
const afterRepositories = (model: Model, context: PageContext): Return => {
	if (model.pendingScans.length === 0) return { model }
	const { pending, hasSettled } = settlePendingScans(model.pendingScans, repositoriesOf(model))
	const settled = { ...model, pendingScans: pending }
	return hasSettled ? readFindings(settled, context, "Supersede") : { model: settled }
}

const TRIAGE_TOAST = {
	open: "Finding reopened",
	dismissed: `Marked ${STATUS_FILTER_LABEL.dismissed.toLowerCase()}`,
	accepted_risk: `Marked ${STATUS_FILTER_LABEL.accepted_risk.toLowerCase()}`,
} satisfies Record<DependencyFindingTriageStatus, string>

/** The answer's status as a triage one; a write never answers `fixed`, so it reads as open. */
const triageStatusOf = (status: DependencyFindingStatus): DependencyFindingTriageStatus =>
	status === "fixed" ? "open" : status

const triage = (model: Model, status: DependencyFindingTriageStatus): Return => {
	const finding = selectedFindingOf(model)
	if (finding === null || !model.isAdmin || model.savingStatus !== null) return { model }
	const reason = model.reason.value.trim()
	// Reopening needs no reason; setting a finding aside does.
	if (status !== "open" && reasonErrorOf(reason) !== null)
		return { model: { ...model, isReasonSubmitted: true } }
	return {
		model: { ...model, isReasonSubmitted: true, savingStatus: status },
		commands: [UpdateFinding({ findingId: finding.id, status, reason })],
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedReadIsAdmin: ({ isAdmin }) => ({ model: { ...model, isAdmin } }),
		CompletedFetchRepositories: ({ key, result }) =>
			afterRepositories(
				{ ...model, repositories: Keyed.accept(model.repositories, key, result) },
				context,
			),
		CompletedFetchFindings: ({ key, result }) => ({
			model: { ...model, findings: Keyed.accept(model.findings, key, result) },
		}),
		ClickedRetry: () => readAll(model, context, "Refresh"),
		ClickedScanNow: ({ repositoryId }) =>
			isScanPending(model, repositoryId)
				? { model }
				: {
						model: { ...model, requestingScans: [...model.requestingScans, repositoryId] },
						commands: [ScanRepository({ repositoryId })],
					},
		CompletedScanRequest: ({ repositoryId, result }) => {
			const requested = {
				...model,
				requestingScans: model.requestingScans.filter((id) => id !== repositoryId),
			}
			return Result.match(result, {
				onSuccess: () => {
					const repository = repositoriesOf(model).find((entry) => entry.id === repositoryId)
					const pending = {
						repositoryId,
						requestedAtMs: model.nowMs,
						previousScanId: repository?.latestScan?.id ?? null,
					}
					return {
						model: { ...requested, pendingScans: [...requested.pendingScans, pending] },
						outMessage: toast("success", "Scan queued", repository?.fullName ?? ""),
					}
				},
				onFailure: (failure) => ({
					model: requested,
					outMessage: toast("error", failure.title, failure.message),
				}),
			})
		},
		TickedScanPoll: ({ nowMs }) => {
			const pendingScans = unexpiredScans(model.pendingScans, nowMs)
			const next = { ...model, nowMs, pendingScans }
			return pendingScans.length === 0 ? { model: next } : readRepositories(next, context, "Supersede")
		},
		GotStatusSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.statusSelect,
				inner,
				(statusSelect) => ({ statusSelect }),
				(next) => Message.GotStatusSelectMessage({ message: next }),
			),
		GotRepositorySelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.repositorySelect,
				inner,
				(repositorySelect) => ({ repositorySelect }),
				(next) => Message.GotRepositorySelectMessage({ message: next }),
			),
		ClickedFinding: ({ findingId }) =>
			sheetStep(
				{ ...model, selectedId: findingId, reason: Field.init(), isReasonSubmitted: false },
				Dialog.open(model.sheet),
			),
		ClickedAdvisoryLink: () => ({ model }),
		GotSheetMessage: ({ message: inner }) => sheetStep(model, Dialog.update(model.sheet, inner)),
		GotReasonMessage: ({ message: inner }) => ({
			model: { ...model, reason: Field.update(model.reason, inner).model },
		}),
		ClickedTriage: ({ status }) => triage(model, status),
		CompletedTriage: ({ result }) =>
			Result.match(result, {
				onSuccess: (finding) => ({
					...readFindings(
						{
							...model,
							savingStatus: null,
							isReasonSubmitted: false,
							reason: Field.init(),
						},
						context,
						"Supersede",
					),
					outMessage: toast(
						"success",
						TRIAGE_TOAST[triageStatusOf(finding.status)],
						finding.packageName,
					),
				}),
				onFailure: (failure) => ({
					model: { ...model, savingStatus: null },
					outMessage: toast("error", failure.title, failure.message),
				}),
			}),
	})
