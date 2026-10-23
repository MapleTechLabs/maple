import type { GithubRepoSummary, SecurityAuditRun } from "@maple/domain/http"
import type { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import type { SecurityFindingsSearch, SecurityRunsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as AddTarget from "../kit/add-target"
import { isLive, SECURITY_SEVERITY_ORDER } from "../kit/format"
import {
	FetchFindings,
	FetchGithubStatus,
	FetchLatestRun,
	FetchRuns,
	FetchTargets,
	ReadSecurityClock,
	ReadSecurityIsAdmin,
	StartRun,
} from "./command"
import { latestRunOf, runsOf, targetsOf } from "./derive"
import { Message, type Model, type Tab } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export type SecurityTabsRoute = Extract<
	AppRoute,
	{ readonly _tag: "Security" | "SecurityFindings" | "SecurityRuns" }
>

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const tabOfRoute = (route: SecurityTabsRoute): Tab =>
	route._tag === "Security" ? "overview" : route._tag === "SecurityFindings" ? "findings" : "runs"

// SELECTS

export const SEVERITY_VALUES: ReadonlyArray<string> = ["all", ...SECURITY_SEVERITY_ORDER]
export const VERDICT_VALUES: ReadonlyArray<string> = ["all", "confirmed", "needs_validation"]

const selectFor = (id: string, values: ReadonlyArray<string>, value: string): Select.Model => {
	const index = values.indexOf(value)
	return Select.init(id, { value, selectedIndex: index === -1 ? null : index })
}

/** Keeps the selects' closed value on the URL's, without closing an open one. */
const withSelectValues = (model: Model): Model => ({
	...model,
	severitySelect: { ...model.severitySelect, value: model.findingsSearch.severity ?? "all" },
	verdictSelect: { ...model.verdictSelect, value: model.findingsSearch.verdict ?? "all" },
	targetSelect: { ...model.targetSelect, value: model.findingsSearch.target ?? "all" },
	runsTargetSelect: { ...model.runsTargetSelect, value: model.runsSearch.target ?? "all" },
})

// READS

const keyOf = (context: PageContext, operation: string, input: unknown = {}) =>
	requestKey(context.orgId, `securityAudit.${operation}`, input)

const slotStep = <A>(
	model: Model,
	slot: Keyed.Keyed<A, LoadFailure>,
	write: (next: Keyed.Keyed<A, LoadFailure>) => Partial<Model>,
	key: string,
	mode: Keyed.ReadMode,
	command: (key: string) => Commands[number],
): Return =>
	Option.match(Keyed.requestFor(slot, key, mode), {
		onNone: () => ({ model }),
		onSome: (next) => ({ model: { ...model, ...write(next) }, commands: [command(next.key)] }),
	})

const chain = (first: Return, next: (model: Model) => Return): Return => {
	const second = next(first.model)
	return {
		...second,
		commands: [...(first.commands ?? []), ...(second.commands ?? [])],
		outMessage: second.outMessage ?? first.outMessage,
	}
}

const chainAll = (model: Model, steps: ReadonlyArray<(model: Model) => Return>): Return =>
	steps.reduce<Return>((acc, step) => chain(acc, step), { model })

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
) =>
	slotStep(
		model,
		model.findings[targetId] ?? Keyed.idle(),
		(slot) => ({ findings: { ...model.findings, [targetId]: slot } }),
		keyOf(context, "listFindings", { targetId }),
		mode,
		(key) => FetchFindings({ key, targetId }),
	)

const readLatestRun = (model: Model, context: PageContext, run: SecurityAuditRun, mode: Keyed.ReadMode) =>
	slotStep(
		model,
		model.latestRuns[run.id] ?? Keyed.idle(),
		(slot) => ({ latestRuns: { ...model.latestRuns, [run.id]: slot } }),
		keyOf(context, "getRun", { runId: run.id }),
		mode,
		(key) => FetchLatestRun({ key, runId: run.id }),
	)

/** Every target's findings, read once the targets are in. */
const followTargets = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	chainAll(
		model,
		targetsOf(model).map((target) => (next: Model) => readFindings(next, context, target.id, mode)),
	)

/** Each target's latest run, for its coverage. */
const followRuns = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const runs = runsOf(model)
	const latest = targetsOf(model).flatMap((target) => {
		const run = latestRunOf(runs, target.id)
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

/** A write changed the targets or runs: read both again past any read in flight. */
const afterWrite = (model: Model, context: PageContext): Return =>
	chain(readTargets(model, context, "Supersede"), (next) => readRuns(next, context, "Supersede"))

// ENTRY

const searchesOf = (route: SecurityTabsRoute, model?: Model) => ({
	findingsSearch: route._tag === "SecurityFindings" ? route.search : (model?.findingsSearch ?? {}),
	runsSearch: route._tag === "SecurityRuns" ? route.search : (model?.runsSearch ?? {}),
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
		findings: {},
		latestRuns: {},
		githubStatus: Keyed.idle(),
		addTarget: AddTarget.init(),
		startingTargetId: null,
		searchDraft: searches.findingsSearch.q ?? "",
		severitySelect: selectFor("security-severity", SEVERITY_VALUES, "all"),
		verdictSelect: selectFor("security-verdict", VERDICT_VALUES, "all"),
		targetSelect: Select.init("security-target", { value: "all", selectedIndex: 0 }),
		runsTargetSelect: Select.init("security-runs-target", { value: "all", selectedIndex: 0 }),
		expanded: [],
	})
	const loaded = chainAll(model, [
		(next) => readTargets(next, context, "Load"),
		(next) => readRuns(next, context, "Load"),
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
	return {
		model: withSelectValues({
			...model,
			tab: tabOfRoute(route),
			...searches,
			searchDraft:
				route._tag === "SecurityFindings" ? (route.search.q ?? model.searchDraft) : model.searchDraft,
		}),
	}
}

// NAVIGATION

const navigate = (model: Model, url: string, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace }),
})

const findingsUrl = (search: SecurityFindingsSearch) => hrefOf(AppRoute.SecurityFindings({ search }))

/** `all` clears the param, so the URL only carries what narrows the list. */
const withParam = <K extends "severity" | "verdict" | "target">(
	search: SecurityFindingsSearch,
	key: K,
	value: string,
): SecurityFindingsSearch => {
	const { [key]: _dropped, ...rest } = search
	return value === "all" ? rest : { ...rest, [key]: value }
}

const isSeverity = (value: string): value is NonNullable<SecurityFindingsSearch["severity"]> =>
	SECURITY_SEVERITY_ORDER.some((severity) => severity === value)

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

const severityChanged = (model: Model, value: string): Return =>
	navigate(
		model,
		findingsUrl(
			value === "all" || !isSeverity(value)
				? withParam(model.findingsSearch, "severity", "all")
				: { ...model.findingsSearch, severity: value },
		),
	)

const verdictChanged = (model: Model, value: string): Return =>
	navigate(
		model,
		findingsUrl(
			value === "confirmed" || value === "needs_validation"
				? { ...model.findingsSearch, verdict: value }
				: withParam(model.findingsSearch, "verdict", "all"),
		),
	)

const runsTargetChanged = (model: Model, value: string): Return => {
	const search: SecurityRunsSearch = value === "all" ? {} : { target: value }
	return navigate(model, hrefOf(AppRoute.SecurityRuns({ search })))
}

// ADD TARGET

const repositoriesOf = (model: Model): ReadonlyArray<GithubRepoSummary> =>
	Option.match(AsyncData.getData(model.githubStatus.data), {
		onNone: () => [],
		onSome: (status) => status.repositories.filter((repo) => repo.status === "active"),
	})

const addTargetStep = (model: Model, message: AddTarget.Message, context: PageContext): Return => {
	const step = AddTarget.update(model.addTarget, message, repositoriesOf(model))
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
			const before = runsOf(model)
			const next: Model = { ...model, runs: Keyed.accept(model.runs, key, result) }
			const finished = finishedSince(before, runsOf(next))
			return chainAll(next, [
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
		TickedPoll: ({ nowMs }) => readRuns({ ...model, nowMs }, context, "Refresh"),
		ClickedRetry: () =>
			chain(readTargets(model, context, "Refresh"), (next) => readRuns(next, context, "Refresh")),
		ClickedAddTarget: () => {
			const opened = AddTarget.open(model.addTarget)
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
		ChangedSearchDraft: ({ value }) => ({ model: { ...model, searchDraft: value } }),
		GotSeveritySelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.severitySelect,
				inner,
				(severitySelect) => ({ severitySelect }),
				(next) => Message.GotSeveritySelectMessage({ message: next }),
				severityChanged,
			),
		GotVerdictSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.verdictSelect,
				inner,
				(verdictSelect) => ({ verdictSelect }),
				(next) => Message.GotVerdictSelectMessage({ message: next }),
				verdictChanged,
			),
		GotTargetSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.targetSelect,
				inner,
				(targetSelect) => ({ targetSelect }),
				(next) => Message.GotTargetSelectMessage({ message: next }),
				(updated, value) =>
					navigate(updated, findingsUrl(withParam(updated.findingsSearch, "target", value))),
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
			const { rejected: _rejected, ...rest } = model.findingsSearch
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
		ClickedShowAll: ({ group }) => ({
			model: {
				...model,
				expanded: model.expanded.includes(group) ? model.expanded : [...model.expanded, group],
			},
		}),
	})
