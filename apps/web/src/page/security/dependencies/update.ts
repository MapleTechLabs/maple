import type { DependencyFindingStatus, DependencyFindingTriageStatus } from "@maple/domain/dependency-scan"
import { Option, Result, Array as Arr, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import type { AppRoute } from "../../../route"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Select from "@maple/views/ui/select"
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
	ALL_REPOSITORIES,
	dependenciesHref,
	isScanPending,
	PAGE_ROWS,
	reasonErrorOf,
	repositoriesOf,
	scopeLabelOf,
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

/** Closed, the switcher reads the scope; open, it keeps what is being typed. */
const withScopeLabel = (model: Model): Model => {
	if (model.repositoryBox.isOpen) return model
	const label = scopeLabelOf(model)
	return { ...model, repositoryBox: { ...model.repositoryBox, selected: [label], inputValue: label } }
}

/** The scope and the pane follow the URL; the repositories table is every repository's alone. */
const withRoute = (model: Model, route: SecurityDependenciesRoute): Model =>
	withScopeLabel({
		...model,
		shownRows: PAGE_ROWS,
		scope: route.search.repo ?? "all",
		pane:
			route.search.view === "advisories"
				? "advisories"
				: route.search.view === "repositories" && route.search.repo === undefined
					? "repositories"
					: "summary",
	})

export const initialModel = (): Model => ({
	nowMs: 0,
	isAdmin: !isClerkAuthEnabled,
	repositories: Keyed.idle(),
	findings: Keyed.idle(),
	statusSelect: Select.init("security-dependency-status", { value: "open", selectedIndex: 0 }),
	scope: "all",
	repositoryBox: Combobox.init("security-dependency-repository", "single", {
		selected: [ALL_REPOSITORIES],
	}),
	pane: "summary",
	expandedPackages: [],
	fullPackages: [],
	shownRows: PAGE_ROWS,
	requestingScans: [],
	pendingScans: [],
	selectedId: null,
	sheet: Dialog.init(SHEET_ID, "sheet"),
	reason: Field.init(),
	isReasonSubmitted: false,
	savingStatus: null,
})

export const init = (route: SecurityDependenciesRoute, context: PageContext): Return => {
	const loaded = readAll(withRoute(initialModel(), route), context, "Load")
	return {
		...loaded,
		commands: [
			ReadDependenciesClock(),
			...(isClerkAuthEnabled ? [ReadDependenciesIsAdmin()] : []),
			...(loaded.commands ?? []),
		],
	}
}

/** Same instance: only the focused repository changed, so nothing is read again. */
export const routeChanged = (model: Model, route: SecurityDependenciesRoute, _context: PageContext): Return =>
	dropUnknownRepository({ model: withRoute(model, route) })

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

/** A repository picked in the switcher is the same link as its matrix column; the current one stays put. */
const scopePicked = (model: Model, label: string): Return => {
	const repositoryId =
		label === ALL_REPOSITORIES
			? null
			: (repositoriesOf(model).find((repository) => repository.fullName === label)?.id ?? null)
	if (label !== ALL_REPOSITORIES && repositoryId === null) return { model: withScopeLabel(model) }
	if ((repositoryId ?? "all") === model.scope) return { model }
	return {
		model,
		outMessage: PageOutMessage.RequestedNavigation({
			// One repository has no repositories table, so it opens on its upgrade plan.
			url: dependenciesHref(repositoryId, model.pane === "repositories" ? "summary" : model.pane),
			isReplace: false,
		}),
	}
}

const repositoryBoxStep = (model: Model, message: Combobox.Message): Return => {
	const next = Combobox.update(model.repositoryBox, message)
	const updated = { ...model, repositoryBox: next.model }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotRepositoryBoxMessage({ message: inner }),
	)
	const step =
		next.outMessage?._tag === "ChangedValue"
			? scopePicked(updated, next.outMessage.value)
			: // Closing without a pick puts the scope's name back.
				{ model: next.model.isOpen ? updated : withScopeLabel(updated) }
	return { ...step, commands: [...commands, ...(step.commands ?? [])] }
}

/** A `?repo=` no connected repository answers to is dropped from the URL once they are read. */
const dropUnknownRepository = (step: Return): Return => {
	const { scope } = step.model
	const repositories = Option.getOrNull(AsyncData.getData(step.model.repositories.data))
	if (scope === "all" || repositories === null || step.outMessage !== undefined) return step
	return Arr.some(repositories.repositories, (repository) => repository.id === scope)
		? step
		: {
				...step,
				outMessage: PageOutMessage.RequestedNavigation({
					url: dependenciesHref(null, step.model.pane),
					isReplace: true,
				}),
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
	dismissed: `Marked ${Str.toLowerCase(STATUS_FILTER_LABEL.dismissed)}`,
	accepted_risk: `Marked ${Str.toLowerCase(STATUS_FILTER_LABEL.accepted_risk)}`,
} satisfies Record<DependencyFindingTriageStatus, string>

/** The answer's status as a triage one; a write never answers `fixed`, so it reads as open. */
const triageStatusOf = (status: DependencyFindingStatus): DependencyFindingTriageStatus =>
	status === "fixed" ? "open" : status

const triage = (model: Model, status: DependencyFindingTriageStatus): Return => {
	const finding = selectedFindingOf(model)
	if (finding === null || !model.isAdmin || model.savingStatus !== null) return { model }
	const reason = Str.trim(model.reason.value)
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
			dropUnknownRepository(
				afterRepositories(
					withScopeLabel({ ...model, repositories: Keyed.accept(model.repositories, key, result) }),
					context,
				),
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
				requestingScans: Arr.filter(model.requestingScans, (id) => id !== repositoryId),
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
				// Another status is another list, read from its top.
				(statusSelect) => ({ statusSelect, shownRows: PAGE_ROWS }),
				(next) => Message.GotStatusSelectMessage({ message: next }),
			),
		GotRepositoryBoxMessage: ({ message: inner }) => repositoryBoxStep(model, inner),
		ClickedShowAllRepositories: ({ key }) => ({
			model: { ...model, fullPackages: [...model.fullPackages, key] },
		}),
		ClickedShowMoreRows: () => ({ model: { ...model, shownRows: model.shownRows + PAGE_ROWS } }),
		ClickedPackage: ({ key }) => ({
			model: {
				...model,
				expandedPackages: model.expandedPackages.includes(key)
					? Arr.filter(model.expandedPackages, (expanded) => expanded !== key)
					: [...model.expandedPackages, key],
			},
		}),
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
