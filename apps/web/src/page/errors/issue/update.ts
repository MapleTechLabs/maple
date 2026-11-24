import { keyed, runSteps, type Step as KitStep } from "../../kit/keyed-step"
import { chartEnvHandlers } from "@maple/views/charts/chart-env"
import type { RequestMode } from "@maple/views/data/keyed"
import { type ErrorIssueId, ErrorIssuePullRequestId } from "@maple/domain/http"
import { Array as Arr, Option, Result, Schema, String as Str } from "effect"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { SETUP_CARD_ID } from "./model"
import { AsyncData, Command } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { integrationStatusKey } from "../../kit/integration-status-keys"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as Combobox from "@maple/views/ui/combobox"
import * as HoverCard from "@maple/views/ui/hover-card"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	CreateInvestigation,
	UnlinkPullRequest,
	CommentOnIssue,
	FetchAffectedUsers,
	FetchAnomalies,
	FetchDetail,
	FetchEscalations,
	FetchEvents,
	FetchGithubStatus,
	FetchInvestigations,
	FetchIssueSession,
	FetchPullRequests,
	FetchVcsPullRequests,
	FetchVerifications,
	ResolveWindow,
} from "./command"
import {
	bucketRangeOf,
	chartWindowOf,
	DEFAULT_PRESET,
	detailOf,
	detailQueryOf,
	investigationPayload,
	pullRequestsOf,
	type Search,
} from "./derive"
import { Message } from "./message"
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
import { isIssueSeverity } from "../../kit/issue-severity"
import { acceptGrants } from "../../kit/session-grants"
import { initialGrants, readsSessionGrants } from "../kit/grants"
import {
	clickedMergeSimilar,
	clickedSplitOut,
	completedGroupingWrite,
	groupingReads,
	retryGrouping,
	toggledSkippedFrames,
} from "./grouping"

const decodePullRequestId = Schema.decodeUnknownOption(ErrorIssuePullRequestId)

export type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>
type Step = KitStep<Model, Message>

const NO_STEP: Step = { patch: {}, commands: [] }

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
					integrationStatusKey(context.orgId, "github"),
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

/** The rail's affected users, over the same window as the detail. */
const affectedUsersStep =
	(context: PageContext, window: TimeWindow, mode: Keyed.ReadMode) =>
	(model: Model): Step =>
		keyed(
			model.affectedUsers,
			requestKey(context.orgId, "errors.listIssueAffectedUsers", { id: model.issueId, window }),
			mode,
			(affectedUsers) => ({ affectedUsers }),
			(key) => FetchAffectedUsers({ key, issueId: model.issueId, ...window }),
		)

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

export const init = (
	route: { readonly issueId: ErrorIssueId; readonly search: Search },
	context: PageContext,
): Return => {
	const model: Model = {
		issueId: route.issueId,
		search: route.search,
		grants: initialGrants,
		window: null,
		nowMs: 0,
		leaseNowMs: 0,
		detail: Keyed.idle(),
		events: Keyed.idle(),
		affectedUsers: Keyed.idle(),
		investigations: Keyed.idle(),
		pullRequests: Keyed.idle(),
		verifications: Keyed.idle(),
		escalations: Keyed.idle(),
		anomalies: Keyed.idle(),
		githubStatus: Keyed.idle(),
		grouping: Keyed.idle(),
		similar: Keyed.idle(),
		openSkippedFrames: [],
		stackToggles: [],
		isShowingRawStack: false,
		splittingHash: null,
		mergingIssueId: null,
		groupingError: null,
		isRightRailMounted: false,
		vcsPullRequests: Keyed.idle(),
		destinations: [],
		timePicker: TimeRangePicker.init("issue-time-range"),
		statusSelect: Select.init("issue-status", { value: "triage", selectedIndex: null }),
		severitySelect: Select.init("issue-severity", { value: "none", selectedIndex: null }),
		fingerprintCopy: CopyButton.init(),
		issueIdCopy: CopyButton.init(),
		promptCopy: CopyButton.init(),
		setupPromptCopy: CopyButton.init(),
		setupCard: HoverCard.init(SETUP_CARD_ID, {
			openDelayMs: 150,
			side: "top",
			align: "start",
			sideOffset: 6,
		}),
		chart: Chart.init(),
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
	const reads = runSteps(model, issueReads(context)(model))
	return {
		model: reads.model,
		commands: [
			resolveCommand(model.search, context, "Load"),
			...(readsSessionGrants ? [FetchIssueSession({ orgId: context.orgId })] : []),
			...(reads.commands ?? []),
			LoadChartRuntime(),
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
		resolve: (): Return =>
			runSteps(next, [groupingReads(context, "Load")], {
				model: next,
				commands: [resolveCommand(route.search, context, snapModeOf(model.refreshVersion))],
			}),
		requestAll: () => {
			const reads = groupingReads(context, "Load")(next)
			return reads.commands.length === 0
				? { model: next }
				: { model: { ...next, ...reads.patch }, commands: reads.commands }
		},
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

/** The reads a write invalidates: the detail, affected users, timeline, escalations, PRs, verifications. */
const refreshAfterWrite =
	(context: PageContext) =>
	(model: Model): { readonly model: Model; readonly commands: ReadonlyArray<Cmd> } => {
		const key = (operation: string) => requestKey(context.orgId, operation, model.issueId)
		const issueId = model.issueId
		const result = runSteps(model, [
			...(model.window === null
				? []
				: [
						detailStep(context, model.window, "Supersede"),
						affectedUsersStep(context, model.window, "Supersede"),
					]),
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

const latestStacktraceOf = (model: Model): string | null =>
	Option.match(detailOf(model), { onNone: () => null, onSome: (detail) => detail.latestStacktrace })

/** The new detail; rows flipped open or closed belong to the old stack, so a different one resets them. */
const withDetail = (model: Model, detail: Model["detail"]): Model => {
	const next = { ...model, detail }
	return latestStacktraceOf(next) === latestStacktraceOf(model)
		? next
		: { ...next, stackToggles: [], isShowingRawStack: false }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			runSteps({ ...model, window, nowMs }, [
				detailStep(context, window, mode),
				affectedUsersStep(context, window, mode),
			]),
		CompletedFetchSession: (answer) => ({ model: acceptGrants(model, context.orgId, answer) }),
		CompletedFetchDetail: ({ key, result }) =>
			runSteps(syncSelects(withDetail(model, Keyed.accept(model.detail, key, result))), [
				loadedReads(context),
				vcsStep(context),
				groupingReads(context, "Load"),
			]),
		MountedRightRail: () =>
			model.isRightRailMounted
				? { model }
				: runSteps({ ...model, isRightRailMounted: true }, [loadedReads(context), vcsStep(context)]),
		CompletedFetchEvents: ({ key, result }) => ({
			model: { ...model, events: Keyed.accept(model.events, key, result) },
		}),
		CompletedFetchAffectedUsers: ({ key, result }) => ({
			model: { ...model, affectedUsers: Keyed.accept(model.affectedUsers, key, result) },
		}),
		CompletedFetchInvestigations: ({ key, result }) => ({
			model: { ...model, investigations: Keyed.accept(model.investigations, key, result) },
		}),
		CompletedFetchPullRequests: ({ key, result }) =>
			runSteps({ ...model, pullRequests: Keyed.accept(model.pullRequests, key, result) }, [
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
			runSteps({ ...model, githubStatus: Keyed.accept(model.githubStatus, key, result) }, [
				vcsStep(context),
			]),
		CompletedFetchVcsPullRequests: ({ key, result }) => ({
			model: { ...model, vcsPullRequests: Keyed.accept(model.vcsPullRequests, key, result) },
		}),
		CompletedFetchGrouping: ({ key, result }) => ({
			model: { ...model, grouping: Keyed.accept(model.grouping, key, result) },
		}),
		CompletedFetchSimilar: ({ key, result }) => ({
			model: { ...model, similar: Keyed.accept(model.similar, key, result) },
		}),
		ClickedRetryGrouping: () => retryGrouping(model, context, "grouping"),
		ClickedRetrySimilar: () => retryGrouping(model, context, "similar"),
		ToggledSkippedFrames: ({ fingerprintHash }) => toggledSkippedFrames(model, fingerprintHash),
		ToggledStackRow: ({ key }) => ({
			model: {
				...model,
				stackToggles: model.stackToggles.includes(key)
					? Arr.filter(model.stackToggles, (toggled) => toggled !== key)
					: [...model.stackToggles, key],
			},
		}),
		ToggledRawStack: () => ({ model: { ...model, isShowingRawStack: !model.isShowingRawStack } }),
		ClickedSplitOut: ({ fingerprintHash }) => clickedSplitOut(model, fingerprintHash),
		CompletedSplitOut: ({ fingerprintHash, result }) =>
			completedGroupingWrite(
				model,
				context,
				result,
				{ target: fingerprintHash, success: "Split out into its own issue" },
				refreshAfterWrite(context),
			),
		ClickedMergeSimilar: ({ sourceIssueId }) => clickedMergeSimilar(model, sourceIssueId),
		CompletedMergeSimilar: ({ sourceIssueId, result }) =>
			completedGroupingWrite(
				model,
				context,
				result,
				{ target: sourceIssueId, success: "Merged into this issue" },
				refreshAfterWrite(context),
			),
		UpdatedDestinations: ({ orgId, destinations }) =>
			orgId === context.orgId ? { model: { ...model, destinations } } : { model },
		TickedLeaseClock: ({ nowMs }) => ({ model: { ...model, leaseNowMs: nowMs } }),
		...chartEnvHandlers(model),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return runSteps(reloaded, [groupingReads(context, "Refresh")], {
				model: reloaded,
				commands: [
					resolveCommand(model.search, context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			})
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedRetry: () =>
			model.window === null
				? { model }
				: runSteps(model, [
						detailStep(context, model.window, "Supersede"),
						affectedUsersStep(context, model.window, "Supersede"),
					]),
		ClickedResetTimeRange: () =>
			navigateSearch(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		ClickedOccurrenceBar: () => {
			const window = model.window
			const bucket = Option.getOrNull(model.chart.activeKey)
			const range =
				window === null || bucket === null
					? null
					: bucketRangeOf(bucket, chartWindowOf(window).bucketMs)
			return range === null
				? { model }
				: navigateSearch(model, {
						...model.search,
						startTime: formatWarehouseDateTime(range.startMs),
						endTime: formatWarehouseDateTime(range.endMs),
						timePreset: undefined,
					})
		},
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
				(m, value) => pickedSeverity(m, isIssueSeverity(value) ? value : null),
			),
		ClickedClaim: () => startWrite(model, { _tag: "Claim" }),
		ClickedUnmerge: () => startWrite(model, { _tag: "Unmerge" }),
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
		// The picked repository's pull requests, with the search cleared.
		GotRepositorySelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.repositorySelect,
				inner,
				(repositorySelect) => ({ repositorySelect }),
				(next) => Message.GotRepositorySelectMessage({ message: next }),
				(picked, value) =>
					runSteps({ ...clearedAttach(picked), attachRepository: value }, [vcsStep(context)]),
			),
		GotAttachDialogMessage: ({ message: inner }) => attachDialogStep(model, inner),
		GotAttachComboboxMessage: ({ message: inner }) => attachComboboxStep(model, inner),
		ChangedAttachDraft: ({ value }) => ({ model: { ...model, attachDraft: value } }),
		SubmittedAttach: () => submittedAttach(model),
		ClickedRetryEvents: () =>
			runSteps(model, [
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
			const body = Str.trim(model.commentDraft)
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
						title: "Couldn't add comment",
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
						title: "Couldn't detach the pull request",
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
					...runSteps({ ...model, isStartingInvestigation: false }, [
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
		GotSetupCardMessage: ({ message: inner }) =>
			lift(
				model,
				HoverCard.update(model.setupCard, inner),
				(setupCard) => ({ setupCard }),
				(next) => Message.GotSetupCardMessage({ message: next }),
			),
		GotSetupPromptCopyMessage: ({ message: inner }) =>
			lift(
				model,
				CopyButton.update(model.setupPromptCopy, inner),
				(setupPromptCopy) => ({ setupPromptCopy }),
				(next) => Message.GotSetupPromptCopyMessage({ message: next }),
			),
		GotPromptCopyMessage: ({ message: inner }) =>
			lift(
				model,
				CopyButton.update(model.promptCopy, inner),
				(promptCopy) => ({ promptCopy }),
				(next) => Message.GotPromptCopyMessage({ message: next }),
			),
		GotChartMessage: ({ message: inner }) =>
			lift(
				model,
				Chart.update(model.chart, inner),
				(chart) => ({ chart }),
				(next) => Message.GotChartMessage({ message: next }),
			),
	})
