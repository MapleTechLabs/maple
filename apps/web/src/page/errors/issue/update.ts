import { type ErrorIssueId, ErrorIssuePullRequestId, type IssueSeverity } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as Combobox from "../../../ui/combobox"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	CreateInvestigation,
	UnlinkPullRequest,
	CommentOnIssue,
	FetchAnomalies,
	FetchDetail,
	FetchEscalations,
	FetchEvents,
	FetchGithubStatus,
	FetchInvestigations,
	FetchPullRequests,
	FetchVcsPullRequests,
	FetchVerifications,
	ResolveWindow,
} from "./command"
import {
	DEFAULT_PRESET,
	detailOf,
	detailQueryOf,
	investigationPayload,
	pullRequestsOf,
	type Search,
} from "./derive"
import { Message, type RequestMode } from "./message"
import type { Model } from "./model"
import { overflowStep } from "./overflow"
import {
	attachComboboxStep,
	attachDialogStep,
	clearedAttach,
	completedAttach,
	githubOf,
	openAttach,
	submittedAttach,
} from "./attach"
import { copyToast } from "../../kit/clipboard"
import {
	completedWrite,
	confirmedSeverity,
	evaluatedEscalation,
	pickedSeverity,
	pickedState,
	severityConfirmStep,
	startWrite,
} from "./writes"

const decodePullRequestId = Schema.decodeUnknownOption(ErrorIssuePullRequestId)

export type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>
type Step = Readonly<{ patch: Partial<Model>; commands: ReadonlyArray<Cmd> }>

const NO_STEP: Step = { patch: {}, commands: [] }

const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.ReadMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: (key: string) => Cmd,
): Step =>
	Option.match(Keyed.requestFor(slot, key, mode), {
		onNone: () => NO_STEP,
		onSome: (next) => ({ patch: write(next), commands: [fetch(next.key)] }),
	})

const applySteps = (model: Model, steps: ReadonlyArray<(model: Model) => Step>): Return =>
	steps.reduce<{ model: Model; commands: ReadonlyArray<Cmd> }>(
		(acc, step) => {
			const next = step(acc.model)
			return { model: { ...acc.model, ...next.patch }, commands: [...acc.commands, ...next.commands] }
		},
		{ model, commands: [] },
	)

const resolveCommand = (search: Search, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: search.startTime,
		endTime: search.endTime,
		preset: search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

/** The window-independent reads every mounted panel makes, keyed by issue. */
const issueReads =
	(context: PageContext) =>
	(model: Model): ReadonlyArray<(model: Model) => Step> => {
		const key = (operation: string) => requestKey(context.orgId, operation, model.issueId)
		const issueId = model.issueId
		return [
			(m) =>
				keyed(
					m.events,
					key("errors.listIssueEvents"),
					"Load",
					(events) => ({ events }),
					(k) => FetchEvents({ key: k, issueId }),
				),
			(m) =>
				keyed(
					m.investigations,
					key("investigations.list"),
					"Load",
					(investigations) => ({ investigations }),
					(k) => FetchInvestigations({ key: k, issueId }),
				),
			(m) =>
				keyed(
					m.pullRequests,
					key("errors.listIssuePullRequests"),
					"Load",
					(pullRequests) => ({ pullRequests }),
					(k) => FetchPullRequests({ key: k, issueId }),
				),
			(m) =>
				keyed(
					m.verifications,
					key("errors.listIssueVerifications"),
					"Load",
					(verifications) => ({ verifications }),
					(k) => FetchVerifications({ key: k, issueId }),
				),
			(m) =>
				keyed(
					m.escalations,
					key("errors.listIssueEscalations"),
					"Load",
					(escalations) => ({ escalations }),
					(k) => FetchEscalations({ key: k, issueId }),
				),
		]
	}

/** Reads made by panels that only mount with the loaded issue: anomalies, the attach dialog. */
const loadedReads =
	(context: PageContext) =>
	(model: Model): Step => {
		if (!AsyncData.hasData(model.detail.data)) return NO_STEP
		const issueId = model.issueId
		const anomalies = keyed(
			model.anomalies,
			requestKey(context.orgId, "anomalies.listIncidents", issueId),
			"Load",
			(next) => ({ anomalies: next }),
			(k) => FetchAnomalies({ key: k, issueId }),
		)
		const github = !model.isRightRailMounted
			? NO_STEP
			: keyed(
					model.githubStatus,
					requestKey(context.orgId, "integrations.githubStatus", {}),
					"Load",
					(next) => ({ githubStatus: next }),
					(k) => FetchGithubStatus({ key: k }),
				)
		return {
			patch: { ...anomalies.patch, ...github.patch },
			commands: [...anomalies.commands, ...github.commands],
		}
	}

const detailStep =
	(context: PageContext, window: TimeWindow, mode: Keyed.ReadMode) =>
	(model: Model): Step => {
		const query = detailQueryOf(window)
		return keyed(
			model.detail,
			requestKey(context.orgId, "errorIssues.retrieve", { id: model.issueId, query }),
			mode,
			(detail) => ({ detail }),
			(key) => FetchDetail({ key, issueId: model.issueId, query }),
		)
	}

const selectedRepository = (model: Model): string | null => githubOf(model).repository

/** `vcsPullRequests` for the selected repository; a query without one is never sent. */
const vcsStep =
	(context: PageContext) =>
	(model: Model): Step => {
		const repository = selectedRepository(model)
		if (repository === null) return NO_STEP
		return keyed(
			model.vcsPullRequests,
			requestKey(context.orgId, "integrations.vcsPullRequests", { repository }),
			"Load",
			(vcsPullRequests) => ({ vcsPullRequests }),
			(key) => FetchVcsPullRequests({ key, repository }),
		)
	}

/** The selects show the issue's own state and severity once it is known. */
const syncSelects = (model: Model): Model =>
	Option.match(AsyncData.getData(model.detail.data), {
		onNone: () => model,
		onSome: ({ workflow_state, severity }) => ({
			...model,
			statusSelect: { ...model.statusSelect, value: workflow_state },
			severitySelect: { ...model.severitySelect, value: severity ?? "none" },
		}),
	})

// ENTRY POINTS

export const init = (
	route: { readonly issueId: ErrorIssueId; readonly search: Search },
	context: PageContext,
): Return => {
	const model: Model = {
		issueId: route.issueId,
		search: route.search,
		window: null,
		nowMs: 0,
		leaseNowMs: 0,
		detail: Keyed.idle(),
		events: Keyed.idle(),
		investigations: Keyed.idle(),
		pullRequests: Keyed.idle(),
		verifications: Keyed.idle(),
		escalations: Keyed.idle(),
		anomalies: Keyed.idle(),
		githubStatus: Keyed.idle(),
		isRightRailMounted: false,
		vcsPullRequests: Keyed.idle(),
		destinations: [],
		timePicker: TimeRangePicker.init("issue-time-range"),
		statusSelect: Select.init("issue-status", { value: "triage", selectedIndex: null }),
		severitySelect: Select.init("issue-severity", { value: "none", selectedIndex: null }),
		fingerprintCopy: CopyButton.init(),
		issueIdCopy: CopyButton.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		busy: [],
		isStartingInvestigation: false,
		overflowMenu: Menu.init("issue-overflow"),
		attachDialog: Dialog.init("issue-attach-pr", "dialog"),
		attachDraft: "",
		attachRepository: null,
		repositorySelect: Select.init("issue-attach-repository", { value: "", selectedIndex: null }),
		isShowingEarlier: false,
		attachCombobox: Combobox.init("issue-attach-pr-picker", "single"),
		isAttaching: false,
		isDetaching: false,
		commentDraft: "",
		isCommenting: false,
		severityConfirm: Dialog.init("issue-severity-confirm", "alert-dialog"),
		severityPick: 0,
		pendingSeverity: null,
		refreshVersion: 0,
		isReloading: false,
	}
	const reads = applySteps(model, issueReads(context)(model))
	return {
		model: reads.model,
		commands: [
			resolveCommand(model.search, context, "Load"),
			...(reads.commands ?? []),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

/** A tab or window change: the tab only re-renders, a window re-resolves and re-asks the detail. */
export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	const next = { ...model, search: route.search }
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(route.search, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: () => ({ model: next }),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return => ({
	model,
	commands: [resolveCommand(model.search, context, "Load")],
})

/** A Submodel step whose Messages are wrapped back into the page's. */
const lift = <Inner, M>(
	model: Model,
	next: { readonly model: Inner; readonly commands?: ReadonlyArray<Command.Command<M, never, Resources>> },
	write: (inner: Inner) => Partial<Model>,
	wrap: (message: M) => Message,
): Return => ({
	model: { ...model, ...write(next.model) },
	commands: Command.mapMessages(next.commands ?? [], wrap),
})

/** A pick writes; the select stays controlled by the issue, so it shows the issue's value until a re-read. */
const selectStep = (
	model: Model,
	select: Select.Model,
	message: Select.Message,
	write: (select: Select.Model) => Partial<Model>,
	wrap: (message: Select.Message) => Message,
	onPick: (model: Model, value: string) => Return,
): Return => {
	const next = Select.update(select, message)
	const stepped = lift(model, next, write, wrap)
	if (next.outMessage === undefined) return stepped
	const picked = onPick(syncSelects(stepped.model), next.outMessage.value)
	return { ...picked, commands: [...(stepped.commands ?? []), ...(picked.commands ?? [])] }
}

const isSeverity = (value: string): value is IssueSeverity =>
	value === "critical" || value === "high" || value === "medium" || value === "low"

/** The reads a write invalidates (`invalidateKeys`): the detail, timeline, escalations, PRs, verifications. */
const refreshAfterWrite =
	(context: PageContext) =>
	(model: Model): { readonly model: Model; readonly commands: ReadonlyArray<Cmd> } => {
		const key = (operation: string) => requestKey(context.orgId, operation, model.issueId)
		const issueId = model.issueId
		const result = applySteps(model, [
			...(model.window === null ? [] : [detailStep(context, model.window, "Supersede")]),
			(m) =>
				keyed(
					m.events,
					key("errors.listIssueEvents"),
					"Supersede",
					(events) => ({ events }),
					(k) => FetchEvents({ key: k, issueId }),
				),
			(m) =>
				keyed(
					m.escalations,
					key("errors.listIssueEscalations"),
					"Supersede",
					(escalations) => ({ escalations }),
					(k) => FetchEscalations({ key: k, issueId }),
				),
			(m) =>
				keyed(
					m.pullRequests,
					key("errors.listIssuePullRequests"),
					"Supersede",
					(pullRequests) => ({ pullRequests }),
					(k) => FetchPullRequests({ key: k, issueId }),
				),
			(m) =>
				keyed(
					m.verifications,
					key("errors.listIssueVerifications"),
					"Supersede",
					(verifications) => ({ verifications }),
					(k) => FetchVerifications({ key: k, issueId }),
				),
		])
		return { model: result.model, commands: result.commands ?? [] }
	}

const navigateSearch = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.ErrorIssue({ issueId: model.issueId, search })),
		isReplace: false,
	}),
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			applySteps({ ...model, window, nowMs }, [detailStep(context, window, mode)]),
		CompletedFetchDetail: ({ key, result }) =>
			applySteps(syncSelects({ ...model, detail: Keyed.accept(model.detail, key, result) }), [
				loadedReads(context),
				vcsStep(context),
			]),
		MountedRightRail: () =>
			model.isRightRailMounted
				? { model }
				: applySteps({ ...model, isRightRailMounted: true }, [
						loadedReads(context),
						vcsStep(context),
					]),
		CompletedFetchEvents: ({ key, result }) => ({
			model: { ...model, events: Keyed.accept(model.events, key, result) },
		}),
		CompletedFetchInvestigations: ({ key, result }) => ({
			model: { ...model, investigations: Keyed.accept(model.investigations, key, result) },
		}),
		CompletedFetchPullRequests: ({ key, result }) =>
			applySteps({ ...model, pullRequests: Keyed.accept(model.pullRequests, key, result) }, [
				vcsStep(context),
			]),
		CompletedFetchVerifications: ({ key, result }) => ({
			model: { ...model, verifications: Keyed.accept(model.verifications, key, result) },
		}),
		CompletedFetchEscalations: ({ key, result }) => ({
			model: { ...model, escalations: Keyed.accept(model.escalations, key, result) },
		}),
		CompletedFetchAnomalies: ({ key, result }) => ({
			model: { ...model, anomalies: Keyed.accept(model.anomalies, key, result) },
		}),
		CompletedFetchGithubStatus: ({ key, result }) =>
			applySteps({ ...model, githubStatus: Keyed.accept(model.githubStatus, key, result) }, [
				vcsStep(context),
			]),
		CompletedFetchVcsPullRequests: ({ key, result }) => ({
			model: { ...model, vcsPullRequests: Keyed.accept(model.vcsPullRequests, key, result) },
		}),
		UpdatedDestinations: ({ orgId, destinations }) =>
			orgId === context.orgId ? { model: { ...model, destinations } } : { model },
		TickedLeaseClock: ({ nowMs }) => ({ model: { ...model, leaseNowMs: nowMs } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(model.search, context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedRetry: () =>
			model.window === null
				? { model }
				: applySteps(model, [detailStep(context, model.window, "Supersede")]),
		ClickedResetTimeRange: () =>
			navigateSearch(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		ClickedInvestigation: ({ id }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Investigation({ id, search: {} })),
				isReplace: false,
			}),
		}),
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const stepped = lift(
				model,
				next,
				(timePicker) => ({ timePicker }),
				(picker) => Message.GotTimePickerMessage({ message: picker }),
			)
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? stepped
				: {
						...navigateSearch(stepped.model, {
							...model.search,
							...TimeRangePicker.searchPatchOf(next.outMessage),
						}),
						commands: stepped.commands,
					}
		},
		GotStatusSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.statusSelect,
				inner,
				(statusSelect) => ({ statusSelect }),
				(next) => Message.GotStatusSelectMessage({ message: next }),
				pickedState,
			),
		GotSeveritySelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.severitySelect,
				inner,
				(severitySelect) => ({ severitySelect }),
				(next) => Message.GotSeveritySelectMessage({ message: next }),
				(m, value) => pickedSeverity(m, isSeverity(value) ? value : null),
			),
		ClickedClaim: () => startWrite(model, { _tag: "Claim" }),
		ClickedExtendLease: () => startWrite(model, { _tag: "Heartbeat" }),
		ClickedReleaseLease: () => startWrite(model, { _tag: "Release" }),
		CompletedIssueWrite: ({ write, result }) => {
			const done = completedWrite(model, write, result, refreshAfterWrite(context))
			// "In review" with nothing attached is the moment the link is worth asking for.
			const asksForLink =
				Result.isSuccess(result) &&
				write._tag === "Transition" &&
				write.toState === "in_review" &&
				pullRequestsOf(model).length === 0
			if (!asksForLink) return done
			const opened = openAttach(done.model)
			return {
				...done,
				model: opened.model,
				commands: [...(done.commands ?? []), ...(opened.commands ?? [])],
			}
		},
		ClickedAttach: () => openAttach(model),
		ClickedShowEarlier: () => ({ model: { ...model, isShowingEarlier: true } }),
		// `onValueChange`: the picked repository's pull requests, with the search cleared.
		GotRepositorySelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.repositorySelect,
				inner,
				(repositorySelect) => ({ repositorySelect }),
				(next) => Message.GotRepositorySelectMessage({ message: next }),
				(picked, value) =>
					applySteps({ ...clearedAttach(picked), attachRepository: value }, [vcsStep(context)]),
			),
		GotAttachDialogMessage: ({ message: inner }) => attachDialogStep(model, inner),
		GotAttachComboboxMessage: ({ message: inner }) => attachComboboxStep(model, inner),
		ChangedAttachDraft: ({ value }) => ({ model: { ...model, attachDraft: value } }),
		SubmittedAttach: () => submittedAttach(model),
		ClickedRetryEvents: () =>
			applySteps(model, [
				(m) =>
					keyed(
						m.events,
						requestKey(context.orgId, "errors.listIssueEvents", m.issueId),
						"Refresh",
						(events) => ({ events }),
						(k) => FetchEvents({ key: k, issueId: m.issueId }),
					),
			]),
		ChangedCommentDraft: ({ value }) => ({ model: { ...model, commentDraft: value } }),
		ClickedComment: () => {
			const body = model.commentDraft.trim()
			return body.length === 0 || model.isCommenting
				? { model }
				: {
						model: { ...model, isCommenting: true },
						commands: [CommentOnIssue({ issueId: model.issueId, body })],
					}
		},
		CompletedComment: ({ result }) => {
			const settled = { ...model, isCommenting: false }
			return Result.match(result, {
				onFailure: (failure) => ({
					model: settled,
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: "Failed to add comment",
						description: failure.message,
					}),
				}),
				onSuccess: () => {
					const refreshed = refreshAfterWrite(context)({ ...settled, commentDraft: "" })
					return {
						model: refreshed.model,
						commands: refreshed.commands,
						outMessage: PageOutMessage.RequestedToast({
							type: "success",
							title: "Comment added",
							description: "",
						}),
					}
				},
			})
		},
		ClickedDetachPullRequest: ({ id }) =>
			model.isDetaching || model.isAttaching
				? { model }
				: Option.match(decodePullRequestId(id), {
						onNone: () => ({ model }),
						onSome: (pullRequestId) => ({
							model: { ...model, isDetaching: true },
							commands: [UnlinkPullRequest({ issueId: model.issueId, pullRequestId })],
						}),
					}),
		CompletedUnlinkPullRequest: ({ result }) => {
			const settled = { ...model, isDetaching: false }
			return Result.match(result, {
				onFailure: (failure) => ({
					model: settled,
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: "Failed to detach the pull request",
						description: failure.message,
					}),
				}),
				onSuccess: () => {
					const refreshed = refreshAfterWrite(context)(settled)
					return {
						model: refreshed.model,
						commands: refreshed.commands,
						outMessage: PageOutMessage.RequestedToast({
							type: "success",
							title: "Pull request detached",
							description: "",
						}),
					}
				},
			})
		},
		CompletedLinkPullRequest: ({ result }) => {
			const done = Result.match(result, {
				onFailure: (failure) => completedAttach(model, false, failure),
				onSuccess: () => completedAttach(model, true, null),
			})
			if (Result.isFailure(result)) return done
			const refreshed = refreshAfterWrite(context)(done.model)
			return {
				...done,
				model: refreshed.model,
				commands: [...(done.commands ?? []), ...refreshed.commands],
			}
		},
		CompletedEvaluateEscalation: ({ severity, pick, result }) =>
			pick === model.severityPick ? evaluatedEscalation(model, severity, result) : { model },
		GotSeverityConfirmMessage: ({ message: inner }) => severityConfirmStep(model, inner),
		ClickedConfirmSeverity: () => confirmedSeverity(model),
		GotOverflowMenuMessage: ({ message: inner }) =>
			overflowStep(
				model,
				Option.getOrNull(Option.map(detailOf(model), (detail) => detail.issue)),
				inner,
			),
		CompletedCopy: ({ label, isOk }) => ({ model, outMessage: copyToast(label, isOk) }),
		ClickedInvestigate: () =>
			Option.match(detailOf(model), {
				onNone: () => ({ model }),
				onSome: (detail) =>
					model.isStartingInvestigation
						? { model }
						: {
								model: { ...model, isStartingInvestigation: true },
								commands: [CreateInvestigation({ payload: investigationPayload(detail) })],
							},
			}),
		CompletedCreateInvestigation: ({ result }) =>
			Result.match(result, {
				onFailure: (failure) => ({
					model: { ...model, isStartingInvestigation: false },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: failure.title,
						description: failure.message,
					}),
				}),
				// The create invalidates `investigations`, so the linked-investigation read goes again.
				onSuccess: (id) => ({
					...applySteps({ ...model, isStartingInvestigation: false }, [
						(m) =>
							keyed(
								m.investigations,
								requestKey(context.orgId, "investigations.list", m.issueId),
								"Refresh",
								(investigations) => ({ investigations }),
								(k) => FetchInvestigations({ key: k, issueId: m.issueId }),
							),
					]),
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.Investigation({ id, search: {} })),
						isReplace: false,
					}),
				}),
			}),
		GotFingerprintCopyMessage: ({ message: inner }) =>
			lift(
				model,
				CopyButton.update(model.fingerprintCopy, inner),
				(fingerprintCopy) => ({ fingerprintCopy }),
				(next) => Message.GotFingerprintCopyMessage({ message: next }),
			),
		GotIssueIdCopyMessage: ({ message: inner }) =>
			lift(
				model,
				CopyButton.update(model.issueIdCopy, inner),
				(issueIdCopy) => ({ issueIdCopy }),
				(next) => Message.GotIssueIdCopyMessage({ message: next }),
			),
		GotChartMessage: () => ({ model }),
	})
