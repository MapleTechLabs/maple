import type { SecurityAuditRun } from "@maple/domain/http"
import type { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Result } from "effect"
import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { AppRoute, hrefOf } from "../../../route"
import type { SecurityFindingsSearch, SecurityRunsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { chain, chainAll, slotStep } from "../../kit/keyed-step"
import * as AddTarget from "../kit/add-target"
import * as SpendSettings from "../kit/spend-settings"
import { isLive } from "../kit/format"
import {
	FetchFindings,
	FetchGithubStatus,
	FetchLatestRun,
	FetchRuns,
	FetchSettings,
	FetchTargetRuns,
	FetchTargets,
	WaitSecuritySearchDebounce,
	ReadSecurityClock,
	ReadSecurityIsAdmin,
	StartRun,
} from "./command"
import {
	activeRepositoriesOf,
	allRuns,
	latestRunFor,
	runningRuns,
	runsOf,
	settingsOf,
	STATUS_TABS,
	targetsOf,
} from "./derive"
import { Message, type Model, type Tab } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityTabsRoute = Extract<
	AppRoute,
	{ readonly _tag: "SecurityCode" | "SecurityCodeFindings" | "SecurityCodeRuns" }
>

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const tabOfRoute = (route: SecurityTabsRoute): Tab =>
	route._tag === "SecurityCode" ? "overview" : route._tag === "SecurityCodeFindings" ? "findings" : "runs"

// SELECTS

/** Keeps the selects' closed value on the URL's, without closing an open one. */
const withSelectValues = (model: Model): Model => ({
	...model,
	statusSelect: { ...model.statusSelect, value: model.findingsSearch.status ?? "open" },
	targetSelect: { ...model.targetSelect, value: model.findingsSearch.target ?? "all" },
	runsTargetSelect: { ...model.runsTargetSelect, value: model.runsSearch.target ?? "all" },
})

// READS

const keyOf = (context: PageContext, operation: string, input: unknown = {}) =>
	requestKey(context.orgId, `securityAudit.${operation}`, input)

const readTargets = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.targets,
		(targets) => ({ targets }),
		keyOf(context, "listTargets"),
		mode,
		(key) => FetchTargets({ key }),
	)

const readRuns = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.runs,
		(runs) => ({ runs }),
		keyOf(context, "listRuns"),
		mode,
		(key) => FetchRuns({ key }),
	)

const readSettings = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.settings,
		(settings) => ({ settings }),
		keyOf(context, "getSettings"),
		mode,
		(key) => FetchSettings({ key }),
	)

const readGithubStatus = (model: Model, context: PageContext): Return =>
	slotStep(
		model,
		model.githubStatus,
		(githubStatus) => ({ githubStatus }),
		requestKey(context.orgId, "integrations.githubStatus", {}),
		"Load",
		(key) => FetchGithubStatus({ key }),
	)

const readFindings = (
	model: Model,
	context: PageContext,
	targetId: SecurityAuditTargetId,
	mode: Keyed.ReadMode,
): Return =>
	slotStep(
		model,
		model.findings[targetId] ?? Keyed.idle(),
		(slot) => ({ findings: { ...model.findings, [targetId]: slot } }),
		keyOf(context, "listFindings", { targetId }),
		mode,
		(key) => FetchFindings({ key, targetId }),
	)

const readTargetRuns = (
	model: Model,
	context: PageContext,
	targetId: SecurityAuditTargetId,
	mode: Keyed.ReadMode,
): Return =>
	slotStep(
		model,
		model.targetRuns[targetId] ?? Keyed.idle(),
		(slot) => ({ targetRuns: { ...model.targetRuns, [targetId]: slot } }),
		keyOf(context, "listRuns", { targetId }),
		mode,
		(key) => FetchTargetRuns({ key, targetId }),
	)

const readLatestRun = (
	model: Model,
	context: PageContext,
	run: SecurityAuditRun,
	mode: Keyed.ReadMode,
): Return =>
	slotStep(
		model,
		model.latestRuns[run.id] ?? Keyed.idle(),
		(slot) => ({ latestRuns: { ...model.latestRuns, [run.id]: slot } }),
		keyOf(context, "getRun", { runId: run.id }),
		mode,
		(key) => FetchLatestRun({ key, runId: run.id }),
	)

/** Every target's findings and own runs, read once the targets are in. */
const followTargets = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	chainAll(
		model,
		targetsOf(model).flatMap((target) => [
			(next: Model) => readFindings(next, context, target.id, mode),
			(next: Model) => readTargetRuns(next, context, target.id, mode),
		]),
	)

/** Each target's latest run, for its coverage. */
const followRuns = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const latest = targetsOf(model).flatMap((target) => {
		const run = latestRunFor(model, target.id)
		return run === undefined ? [] : [run]
	})
	return chainAll(
		model,
		latest.map((run) => (next: Model) => readLatestRun(next, context, run, isLive(run) ? mode : "Load")),
	)
}

/** Runs that were in progress and have since finished: their targets' findings changed. */
const finishedSince = (
	before: ReadonlyArray<SecurityAuditRun>,
	after: ReadonlyArray<SecurityAuditRun>,
): ReadonlyArray<SecurityAuditRun> =>
	after.filter(
		(run) => !isLive(run) && before.some((previous) => previous.id === run.id && isLive(previous)),
	)

/** A write changed the targets or runs (and so the spend): read them again past any read in flight. */
const afterWrite = (model: Model, context: PageContext): Return =>
	chainAll(model, [
		(next) => readTargets(next, context, "Supersede"),
		(next) => readRuns(next, context, "Supersede"),
		(next) => readSettings(next, context, "Supersede"),
		...targetsOf(model).map(
			(target) => (next: Model) => readTargetRuns(next, context, target.id, "Supersede"),
		),
	])

/** Each target once, in first-seen order. */
const uniqueTargets = (runs: ReadonlyArray<SecurityAuditRun>): ReadonlyArray<SecurityAuditTargetId> => [
	...new Set(runs.map((run) => run.targetId)),
]

// ENTRY

const searchesOf = (route: SecurityTabsRoute, model?: Model) => ({
	findingsSearch: route._tag === "SecurityCodeFindings" ? route.search : (model?.findingsSearch ?? {}),
	runsSearch: route._tag === "SecurityCodeRuns" ? route.search : (model?.runsSearch ?? {}),
})

export const init = (route: SecurityTabsRoute, context: PageContext): Return => {
	const searches = searchesOf(route)
	const model: Model = withSelectValues({
		tab: tabOfRoute(route),
		...searches,
		nowMs: 0,
		isAdmin: !isClerkAuthEnabled,
		targets: Keyed.idle(),
		runs: Keyed.idle(),
		targetRuns: {},
		findings: {},
		latestRuns: {},
		githubStatus: Keyed.idle(),
		settings: Keyed.idle(),
		addTarget: AddTarget.init(),
		spendSettings: SpendSettings.init(),
		startingTargetId: null,
		searchDraft: searches.findingsSearch.q ?? "",
		searchGeneration: 0,
		statusSelect: Select.init("security-status", { value: "open", selectedIndex: 0 }),
		targetSelect: Select.init("security-target", { value: "all", selectedIndex: 0 }),
		runsTargetSelect: Select.init("security-runs-target", { value: "all", selectedIndex: 0 }),
		// Disproved findings start folded, unless the URL asked to show them.
		collapsed: searches.findingsSearch.rejected === true ? [] : ["rejected"],
	})
	const loaded = chainAll(model, [
		(next) => readTargets(next, context, "Load"),
		(next) => readRuns(next, context, "Load"),
		(next) => readSettings(next, context, "Load"),
		(next) => readGithubStatus(next, context),
	])
	return {
		...loaded,
		commands: [
			ReadSecurityClock(),
			...(isClerkAuthEnabled ? [ReadSecurityIsAdmin()] : []),
			...(loaded.commands ?? []),
		],
	}
}

/** Same instance: the tab or its search changed. The data is shared, so nothing is read again. */
export const routeChanged = (model: Model, route: SecurityTabsRoute, _context: PageContext): Return => {
	const searches = searchesOf(route, model)
	const isFindings = route._tag === "SecurityCodeFindings"
	return {
		model: withSelectValues({
			...model,
			tab: tabOfRoute(route),
			...searches,
			// Turning rejected on shows them, not a folded header.
			collapsed:
				searches.findingsSearch.rejected === true && model.findingsSearch.rejected !== true
					? model.collapsed.filter((held) => held !== "rejected")
					: model.collapsed,
			// Leaving Findings drops a pending debounce, so it cannot navigate back there.
			searchGeneration: isFindings ? model.searchGeneration : model.searchGeneration + 1,
			// The draft follows the URL unless it already says the same thing (trailing spaces).
			searchDraft:
				isFindings && draftQuery(model.searchDraft) !== route.search.q
					? (route.search.q ?? "")
					: model.searchDraft,
		}),
	}
}

// NAVIGATION

const draftQuery = (draft: string): string | undefined => draft.trim() || undefined

const navigate = (model: Model, url: string, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace }),
})

const findingsUrl = (search: SecurityFindingsSearch) => hrefOf(AppRoute.SecurityCodeFindings({ search }))

/** The URL's filters with the search box as typed: a filter change does not wait out the debounce. */
const searchWithDraft = (model: Model): SecurityFindingsSearch => {
	const { q: _q, ...rest } = model.findingsSearch
	const q = draftQuery(model.searchDraft)
	return q === undefined ? rest : { ...rest, q }
}

/** `all` clears the param, so the URL only carries what narrows the list. */
const withParam = <K extends "target">(
	search: SecurityFindingsSearch,
	key: K,
	value: string,
): SecurityFindingsSearch => {
	const { [key]: _dropped, ...rest } = search
	return value === "all" ? rest : { ...rest, [key]: value }
}

const selectStep = (
	model: Model,
	select: Select.Model,
	message: Select.Message,
	write: (select: Select.Model) => Partial<Model>,
	wrap: (message: Select.Message) => Message,
	onChange: (model: Model, value: string) => Return,
): Return => {
	const next = Select.update(select, message)
	const updated = { ...model, ...write(next.model) }
	const commands = Command.mapMessages(next.commands ?? [], wrap)
	if (next.outMessage === undefined) return { model: updated, commands }
	const step = onChange(updated, next.outMessage.value)
	return { ...step, commands: [...commands, ...(step.commands ?? [])] }
}

const runsTargetChanged = (model: Model, value: string): Return => {
	const search: SecurityRunsSearch = value === "all" ? {} : { target: value }
	return navigate(model, hrefOf(AppRoute.SecurityCodeRuns({ search })))
}

// ADD TARGET

const addTargetStep = (model: Model, message: AddTarget.Message, context: PageContext): Return => {
	const step = AddTarget.update(model.addTarget, message, activeRepositoriesOf(model))
	const next: Return = {
		model: { ...model, addTarget: step.model },
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotAddTargetMessage({ message: inner }),
		),
	}
	const out = step.outMessage
	if (out === undefined) return next
	const refreshed = chain(next, (updated) => afterWrite(updated, context))
	return AddTarget.OutMessage.match<Return>(out, {
		Added: ({ target, run }) =>
			run === null
				? {
						...refreshed,
						outMessage: toast(
							"success",
							`${target.repository} added`,
							"Start a run from the Runs tab.",
						),
					}
				: {
						...refreshed,
						outMessage: PageOutMessage.RequestedNavigation({
							url: hrefOf(AppRoute.SecurityRun({ runId: run.id })),
							isReplace: false,
							toast: {
								type: "success",
								title: `${target.repository} added`,
								description: "The first run has started.",
							},
						}),
					},
		AddedWithoutRun: ({ target, failure }) => ({
			...refreshed,
			outMessage: toast(
				"error",
				`${target.repository} added, but the first run did not start`,
				failure.message,
			),
		}),
	})
}

// SPEND & MODELS

const spendSettingsStep = (model: Model, message: SpendSettings.Message, context: PageContext): Return => {
	const step = SpendSettings.update(model.spendSettings, message)
	const next: Return = {
		model: { ...model, spendSettings: step.model },
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotSpendSettingsMessage({ message: inner }),
		),
	}
	if (step.outMessage === undefined) return next
	return {
		...chain(next, (updated) => readSettings(updated, context, "Supersede")),
		outMessage: toast(
			"success",
			"Spend & models saved",
			"New runs use them; running audits check the limit before each agent.",
		),
	}
}

// UPDATE

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedReadIsAdmin: ({ isAdmin }) => ({ model: { ...model, isAdmin } }),
		CompletedFetchTargets: ({ key, result }) => {
			const next: Model = { ...model, targets: Keyed.accept(model.targets, key, result) }
			return chain(followTargets(next, context, "Load"), (updated) =>
				followRuns(updated, context, "Load"),
			)
		},
		CompletedFetchRuns: ({ key, result }) => {
			const before = allRuns(model)
			const next: Model = { ...model, runs: Keyed.accept(model.runs, key, result) }
			const finished = finishedSince(before, allRuns(next))
			const known = new Set(before.map((run) => run.id))
			const started = runsOf(next).filter((run) => !known.has(run.id))
			// A target whose run finished or started has a stale own list: read it past any in flight.
			const changed = known.size === 0 ? [] : uniqueTargets([...finished, ...started])
			return chainAll(next, [
				...changed.map(
					(targetId) => (updated: Model) => readTargetRuns(updated, context, targetId, "Supersede"),
				),
				(updated) => followRuns(updated, context, "Refresh"),
				// A finished run's answers supersede reads sent while it was still live.
				...finished.map(
					(run) => (updated: Model) => readFindings(updated, context, run.targetId, "Supersede"),
				),
				...finished.map(
					(run) => (updated: Model) => readLatestRun(updated, context, run, "Supersede"),
				),
			])
		},
		CompletedFetchTargetRuns: ({ targetId, key, result }) => {
			const slot = model.targetRuns[targetId]
			if (slot === undefined) return { model }
			const next: Model = {
				...model,
				targetRuns: { ...model.targetRuns, [targetId]: Keyed.accept(slot, key, result) },
			}
			// A live run only this list held may have finished: its findings and latest run changed.
			const finished = finishedSince(allRuns(model), allRuns(next))
			return chainAll(next, [
				(updated) => followRuns(updated, context, "Load"),
				...finished.map(
					(run) => (updated: Model) => readFindings(updated, context, run.targetId, "Supersede"),
				),
				...finished.map(
					(run) => (updated: Model) => readLatestRun(updated, context, run, "Supersede"),
				),
			])
		},
		CompletedFetchFindings: ({ targetId, key, result }) => {
			const slot = model.findings[targetId]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							findings: { ...model.findings, [targetId]: Keyed.accept(slot, key, result) },
						},
					}
		},
		CompletedFetchLatestRun: ({ runId, key, result }) => {
			const slot = model.latestRuns[runId]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							latestRuns: { ...model.latestRuns, [runId]: Keyed.accept(slot, key, result) },
						},
					}
		},
		CompletedFetchGithubStatus: ({ key, result }) => ({
			model: { ...model, githubStatus: Keyed.accept(model.githubStatus, key, result) },
		}),
		CompletedFetchSettings: ({ key, result }) => ({
			model: { ...model, settings: Keyed.accept(model.settings, key, result) },
		}),
		TickedPoll: ({ nowMs }) =>
			chainAll({ ...model, nowMs }, [
				(next) => readRuns(next, context, "Refresh"),
				// Running agents spend: the month's total moves while any audit runs.
				...(runningRuns(model).length === 0
					? []
					: [(next: Model) => readSettings(next, context, "Refresh")]),
				// A live run the global list no longer holds is still followed through its target's list.
				...uniqueTargets(runningRuns(model)).map(
					(targetId) => (next: Model) => readTargetRuns(next, context, targetId, "Refresh"),
				),
			]),
		ClickedRetry: () =>
			chainAll(model, [
				(next) => readTargets(next, context, "Refresh"),
				(next) => readRuns(next, context, "Refresh"),
				(next) => readSettings(next, context, "Refresh"),
			]),
		ClickedAddTarget: () => {
			const opened = AddTarget.open(model.addTarget, settingsOf(model))
			return chain(
				{
					model: { ...model, addTarget: opened.model },
					commands: Command.mapMessages(opened.commands ?? [], (inner) =>
						Message.GotAddTargetMessage({ message: inner }),
					),
				},
				(next) => readGithubStatus(next, context),
			)
		},
		GotAddTargetMessage: ({ message: inner }) => addTargetStep(model, inner, context),
		ClickedSpendAndModels: () => {
			const settings = settingsOf(model)
			if (settings === null) return { model }
			const opened = SpendSettings.open(model.spendSettings, settings)
			return {
				model: { ...model, spendSettings: opened.model },
				commands: Command.mapMessages(opened.commands ?? [], (inner) =>
					Message.GotSpendSettingsMessage({ message: inner }),
				),
			}
		},
		GotSpendSettingsMessage: ({ message: inner }) => spendSettingsStep(model, inner, context),
		ClickedStartRun: ({ targetId }) =>
			model.startingTargetId !== null
				? { model }
				: { model: { ...model, startingTargetId: targetId }, commands: [StartRun({ targetId })] },
		CompletedStartRun: ({ result }) =>
			Result.match(result, {
				onSuccess: (run) => ({
					...afterWrite({ ...model, startingTargetId: null }, context),
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.SecurityRun({ runId: run.id })),
						isReplace: false,
					}),
				}),
				onFailure: (failure) => ({
					model: { ...model, startingTargetId: null },
					outMessage: toast("error", failure.title, failure.message),
				}),
			}),
		ChangedSearchDraft: ({ value }) => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchDraft: value, searchGeneration },
				commands: [WaitSecuritySearchDebounce({ generation: searchGeneration })],
			}
		},
		ElapsedSearchDebounce: ({ generation }) => {
			const q = draftQuery(model.searchDraft)
			if (
				generation !== model.searchGeneration ||
				model.tab !== "findings" ||
				q === model.findingsSearch.q
			)
				return { model }
			const { q: _q, ...rest } = model.findingsSearch
			return navigate(model, findingsUrl(q === undefined ? rest : { ...rest, q }), true)
		},
		GotStatusSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.statusSelect,
				inner,
				(statusSelect) => ({ statusSelect }),
				(next) => Message.GotStatusSelectMessage({ message: next }),
				(updated, value) => {
					const { status: _status, ...rest } = searchWithDraft(updated)
					const status = STATUS_TABS.find((tab) => tab === value)
					// Open is the default, so the URL only carries another status.
					return navigate(
						updated,
						findingsUrl(status === undefined || status === "open" ? rest : { ...rest, status }),
					)
				},
			),
		GotTargetSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.targetSelect,
				inner,
				(targetSelect) => ({ targetSelect }),
				(next) => Message.GotTargetSelectMessage({ message: next }),
				(updated, value) =>
					navigate(updated, findingsUrl(withParam(searchWithDraft(updated), "target", value))),
			),
		GotRunsTargetSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.runsTargetSelect,
				inner,
				(runsTargetSelect) => ({ runsTargetSelect }),
				(next) => Message.GotRunsTargetSelectMessage({ message: next }),
				runsTargetChanged,
			),
		ToggledShowRejected: () => {
			const { rejected: _rejected, ...rest } = searchWithDraft(model)
			return navigate(
				model,
				findingsUrl(model.findingsSearch.rejected === true ? rest : { ...rest, rejected: true }),
			)
		},
		ClickedClearFilters: () => {
			const status = model.findingsSearch.status
			return navigate(
				{ ...model, searchDraft: "" },
				findingsUrl(status === undefined ? {} : { status }),
			)
		},
		PickedSeverity: ({ bucket }) => {
			if (bucket === "rejected") return { model }
			const { severity: _severity, ...rest } = searchWithDraft(model)
			return navigate(
				bucket === null
					? model
					: { ...model, collapsed: model.collapsed.filter((held) => held !== bucket) },
				findingsUrl(bucket === null ? rest : { ...rest, severity: bucket }),
			)
		},
		ToggledSection: ({ bucket }) => ({
			model: {
				...model,
				collapsed: model.collapsed.includes(bucket)
					? model.collapsed.filter((held) => held !== bucket)
					: [...model.collapsed, bucket],
			},
		}),
	})
