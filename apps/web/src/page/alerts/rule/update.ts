import type { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/domain/http"
import type { V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { formatSignalValue, signalLabels } from "@maple/web-data/alerts/form-utils"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as Menu from "../../../ui/menu"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { alertsHref } from "../shared/links"
import {
	CompleteRuleReloadSpin,
	FetchBucketChecks,
	FetchRuleChecks,
	FetchRuleDeliveries,
	FetchRulePreview,
	LoadMoreChecks,
	OpenRuleInvestigation,
	ReadDiagnosisClock,
	ResolveRuleWindow,
	ToggleRuleEnabled,
} from "./command"
import { checksPageOf, DEFAULT_PRESET, isoOf, payloadOf, ruleIncidentsOf, ruleOf, timelineRangeOf } from "./derive"
import { Message, type RequestMode } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type RuleRoute = Extract<AppRoute, { readonly _tag: "AlertRule" }>
type Step = Readonly<{ patch: Partial<Model>; commands: Commands }>

const RAIL_CELLS = 60

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveRuleWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): ReadonlyArray<Step> =>
	// An atom never refetches a failed read on its own: a same-key `Load` leaves the slot alone.
	mode === "Load" && slot.key === key
		? []
		: Option.match(Keyed.request(slot, key, mode), {
		onNone: () => [],
		onSome: (next) => [{ patch: write(next), commands: [fetch(key)] }],
	})

const applySteps = (model: Model, steps: ReadonlyArray<Step>): Return => ({
	model: steps.reduce<Model>((next, step) => ({ ...next, ...step.patch }), model),
	commands: steps.flatMap((step) => step.commands),
})

/** The window's reads (checks, preview) and the window-free deliveries list. */
const followData = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const org = context.orgId
	const window = model.window
	const deliveriesKey = requestKey(org, "alertDeliveries.list", { query: { limit: 100 } })
	const deliveries = keyed(model.deliveries, deliveriesKey, "Load", (next) => ({ deliveries: next }), (key) =>
		FetchRuleDeliveries({ key }),
	)
	if (window === null) return applySteps(model, deliveries)
	const since = isoOf(window.startTime)
	const until = isoOf(window.endTime)
	const checksKey = requestKey(org, "alertRules.checks", { ruleId: model.ruleId, since, until })
	const checks = keyed(model.checks, checksKey, mode, (next) => ({ checks: next }), (key) =>
		FetchRuleChecks({ key, ruleId: model.ruleId, since, until }),
	)
	const preview = Option.match(payloadOf(model, ruleOf(model)), {
		onNone: (): ReadonlyArray<Step> => [],
		onSome: (payload) =>
			keyed(model.preview, requestKey(org, "alertRules.preview", payload), mode, (next) => ({ preview: next }), (key) =>
				FetchRulePreview({ key, payload }),
			),
	})
	return applySteps(model, [...deliveries, ...checks, ...preview])
}

export const init = (route: RuleRoute, context: PageContext): Return => {
	const model: Model = {
		ruleId: route.ruleId,
		search: route.search,
		window: null,
		nowMs: 0,
		rules: null,
		incidents: null,
		states: null,
		destinations: null,
		deliveries: Keyed.idle(),
		checks: Keyed.idle(),
		preview: Keyed.idle(),
		stateFilter: "all",
		checkStatusFilter: "all",
		signalSource: "preview",
		selectedBucket: null,
		bucketChecks: [],
		isBucketLoading: false,
		bucketRequest: 0,
		isShowingAllIncidents: false,
		extraChecks: [],
		isLoadingMoreChecks: false,
		checksGeneration: 0,
		isDiagnosisExpanded: null,
		isShowingAllStages: false,
		selectedGroup: null,
		stageOpen: {},
		stageEvidenceExpanded: [],
		isTogglingRule: false,
		isOpeningInvestigation: false,
		menus: {},
		timePicker: TimeRangePicker.init("alert-rule-time-picker"),
		refreshVersion: 0,
		isReloading: false,
		chart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	}
	const followed = followData(model, context, "Load")
	return {
		model: followed.model,
		commands: [
			resolveCommand(model, context, "Load"),
			ReadDiagnosisClock(),
			...(followed.commands ?? []),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

/** A tab change only re-renders; a moved window re-resolves. */
export const routeChanged = (model: Model, route: RuleRoute, context: PageContext): Return => {
	const next = { ...model, search: route.search }
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] }),
		requestAll: () => ({ model: next }),
	})
}

const navigate = (model: Model, search: Model["search"]): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.AlertRule({ ruleId: model.ruleId, search })),
		isReplace: false,
	}),
})

const errorToast = (title: string, message: string) =>
	PageOutMessage.RequestedToast({ type: "error", title, description: message })

/** `openInvestigation(incident)`: the incident's investigation, seeded with the rule. */
const investigationPayload = (rule: AlertRuleDocument, incident: AlertIncidentDocument): V2InvestigationCreateParams => ({
	subject:
		incident.errorIssueId != null
			? { type: "incident", incident_kind: "alert", incident_id: incident.id, issue_id: incident.errorIssueId }
			: { type: "incident", incident_kind: "alert", incident_id: incident.id },
	snapshot: {
		title: rule.name,
		scope: incident.groupKey ?? "all",
		status: incident.status,
		severity: incident.severity === "critical" ? "critical" : "medium",
		facts: [
			{ label: "Signal", value: signalLabels[rule.signalType] },
			{ label: "Observed", value: formatSignalValue(rule.signalType, incident.lastObservedValue) },
			{ label: "Threshold", value: formatSignalValue(rule.signalType, incident.threshold) },
		],
		references: incident.errorIssueId ? [{ label: "Issue", url: `/errors/issues/${incident.errorIssueId}` }] : [],
		incidentStartedAt: incident.firstTriggeredAt,
		incidentEndedAt: incident.resolvedAt,
	},
})

const openInvestigation = (model: Model, incidentId: string): Return => {
	const rule = ruleOf(model)
	const incident = ruleIncidentsOf(model).find((candidate) => candidate.id === incidentId)
	return rule === null || incident === undefined || model.isOpeningInvestigation
		? { model }
		: {
				model: { ...model, isOpeningInvestigation: true },
				commands: [OpenRuleInvestigation({ payload: investigationPayload(rule, incident) })],
			}
}

/** Incident row menus are `incident:<id>`. */
export const incidentMenuId = (incidentId: string) => `incident:${incidentId}`

const updateMenu = (model: Model, menuId: string, message: Menu.Message): Return => {
	const result = Menu.update(model.menus[menuId] ?? Menu.init(menuId), message)
	const next: Model = { ...model, menus: { ...model.menus, [menuId]: result.model } }
	const commands = Command.mapMessages(result.commands ?? [], (child) => Message.GotRowMenuMessage({ menuId, message: child }))
	const picked = result.outMessage?._tag === "SelectedItem" ? result.outMessage.value : null
	if (picked === "investigate") {
		const opened = openInvestigation(next, menuId.slice("incident:".length))
		return { ...opened, commands: [...commands, ...(opened.commands ?? [])] }
	}
	if (picked === "all")
		return {
			model: next,
			commands,
			outMessage: PageOutMessage.RequestedNavigation({ url: alertsHref({ tab: "overview" }), isReplace: false }),
		}
	return { model: next, commands }
}

const selectBucket = (model: Model, index: number | null): Return => {
	const request = model.bucketRequest + 1
	if (index === null)
		return { model: { ...model, bucketRequest: request, selectedBucket: null, bucketChecks: [], isBucketLoading: false } }
	const domain = timelineRangeOf(model)
	const range = Math.max(1, domain.max - domain.min)
	const start = domain.min + (index / RAIL_CELLS) * range
	const end = domain.min + ((index + 1) / RAIL_CELLS) * range
	return {
		model: {
			...model,
			bucketRequest: request,
			selectedBucket: { index, start, end },
			bucketChecks: [],
			isBucketLoading: true,
		},
		commands: [
			FetchBucketChecks({
				request,
				ruleId: model.ruleId,
				since: IsoDateTimeString.make(new Date(start).toISOString()),
				until: IsoDateTimeString.make(new Date(end).toISOString()),
			}),
		],
	}
}

const loadMoreChecks = (model: Model): Return => {
	const page = checksPageOf(model)
	const cursor = model.nextCursorOverride === undefined ? (page?.nextCursor ?? null) : model.nextCursorOverride
	// The first page must answer the current window: a previous window's page holds its cursor.
	const isCurrentPage = AsyncData.isSuccess(model.checks.data)
	if (cursor === null || !isCurrentPage || model.isLoadingMoreChecks || model.window === null) return { model }
	return {
		model: { ...model, isLoadingMoreChecks: true },
		commands: [
			LoadMoreChecks({
				ruleId: model.ruleId,
				since: isoOf(model.window.startTime),
				until: isoOf(model.window.endTime),
				cursor,
				status: model.checkStatusFilter,
				generation: model.checksGeneration,
			}),
		],
	}
}

const withRows = (model: Model, context: PageContext, orgId: string, patch: Partial<Model>): Return => {
	if (orgId !== context.orgId) return { model }
	const followed = followData({ ...model, ...patch }, context, "Load")
	return { ...followed, commands: [...(followed.commands ?? []), ReadDiagnosisClock()] }
}

/** The ChecksPanel is keyed by window and status filter: either change starts it over. */
const resetChecksPanel = (model: Model): Model => ({
	...model,
	extraChecks: [],
	nextCursorOverride: undefined,
	isLoadingMoreChecks: false,
	checksGeneration: model.checksGeneration + 1,
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, mode }) =>
			followData(resetChecksPanel({ ...model, window }), context, mode === "Refresh" ? "Refresh" : "Load"),
		UpdatedRules: ({ orgId, rows }) => withRows(model, context, orgId, { rules: rows }),
		UpdatedIncidents: ({ orgId, rows }) => withRows(model, context, orgId, { incidents: rows }),
		UpdatedRuleStates: ({ orgId, rows }) => withRows(model, context, orgId, { states: rows }),
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		ReadDiagnosisClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchDeliveries: ({ key, result }) => ({
			model: { ...model, deliveries: Keyed.accept(model.deliveries, key, result) },
			commands: [ReadDiagnosisClock()],
		}),
		CompletedFetchChecks: ({ key, result }) => ({
			model: { ...model, checks: Keyed.accept(model.checks, key, result) },
			commands: [ReadDiagnosisClock()],
		}),
		CompletedFetchPreview: ({ key, result }) => ({
			model: { ...model, preview: Keyed.accept(model.preview, key, result) },
		}),
		ClickedStateFilter: ({ filter }) => ({ model: { ...model, stateFilter: filter } }),
		ClickedCheckStatusFilter: ({ filter }) => ({ model: resetChecksPanel({ ...model, checkStatusFilter: filter }) }),
		ClickedSignalSource: ({ source }) => ({ model: { ...model, signalSource: source } }),
		ClickedRailBucket: ({ index }) => selectBucket(model, index),
		ClickedClearBucket: () => selectBucket(model, null),
		CompletedFetchBucketChecks: ({ request, result }) =>
			request !== model.bucketRequest
				? { model }
				: Result.match(result, {
						onSuccess: (checks) => ({ model: { ...model, bucketChecks: checks, isBucketLoading: false } }),
						onFailure: () => ({
							model: { ...model, isBucketLoading: false },
							outMessage: PageOutMessage.RequestedToast({
								type: "error",
								title: "Couldn't load checks for that bucket",
								description: "",
							}),
						}),
					}),
		ClickedShowAllIncidents: () => ({ model: { ...model, isShowingAllIncidents: true } }),
		ClickedLoadMoreChecks: () => loadMoreChecks(model),
		CompletedLoadMoreChecks: ({ generation, result }) =>
			generation !== model.checksGeneration
				? { model }
				: Result.match(result, {
				onSuccess: ({ checks, nextCursor }) => ({
					model: {
						...model,
						isLoadingMoreChecks: false,
						extraChecks: [...model.extraChecks, ...checks],
						nextCursorOverride: nextCursor,
					},
				}),
				onFailure: () => ({
					model: { ...model, isLoadingMoreChecks: false },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: "Couldn't load more alert checks",
						description: "",
					}),
				}),
			}),
		ClickedDiagnosisHeader: ({ isOpen }) => ({ model: { ...model, isDiagnosisExpanded: !isOpen } }),
		ClickedShowAllStages: () => ({ model: { ...model, isShowingAllStages: !model.isShowingAllStages } }),
		ClickedDiagnosisGroup: ({ groupKey }) => ({ model: { ...model, selectedGroup: groupKey } }),
		ClickedStage: ({ stageId, isOpen }) => ({ model: { ...model, stageOpen: { ...model.stageOpen, [stageId]: isOpen } } }),
		ClickedShowAllEvidence: ({ stageId }) => ({
			model: { ...model, stageEvidenceExpanded: [...model.stageEvidenceExpanded, stageId] },
		}),
		ClickedToggleEnabled: () => {
			const rule = ruleOf(model)
			return rule === null || model.isTogglingRule
				? { model }
				: {
						model: { ...model, isTogglingRule: true },
						commands: [ToggleRuleEnabled({ ruleId: rule.id, isEnabled: !rule.enabled })],
					}
		},
		CompletedToggleEnabled: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({ model: { ...model, isTogglingRule: false } }),
				onFailure: (failure) => ({
					model: { ...model, isTogglingRule: false },
					outMessage: errorToast("Failed to update rule", failure.message),
				}),
			}),
		ClickedOpenInvestigation: ({ incidentId }) => openInvestigation(model, incidentId),
		CompletedOpenInvestigation: ({ result }) =>
			Result.match(result, {
				onSuccess: (id) => ({
					model: { ...model, isOpeningInvestigation: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.Investigation({ id, search: {} })),
						isReplace: false,
					}),
				}),
				onFailure: (failure) => ({
					model: { ...model, isOpeningInvestigation: false },
					outMessage: errorToast("Failed to open investigation", failure.message),
				}),
			}),
		GotRowMenuMessage: ({ menuId, message: child }) => updateMenu(model, menuId, child),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [resolveCommand(reloaded, context, "Refresh"), CompleteRuleReloadSpin({ version: reloaded.refreshVersion })],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedResetTimeRange: () =>
			navigate(model, { ...model.search, startTime: undefined, endTime: undefined, timePreset: DEFAULT_PRESET }),
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted: Return = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands, (picker) => Message.GotTimePickerMessage({ message: picker })),
			}
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? TimeRangePicker.unpicked(lifted, next.outMessage)
				: {
						...lifted,
						outMessage: PageOutMessage.RequestedNavigation({
							url: hrefOf(
								AppRoute.AlertRule({
									ruleId: model.ruleId,
									search: {
										...model.search,
										...TimeRangePicker.searchPatchOf(next.outMessage),
									},
								}),
							),
							isReplace: false,
						}),
					}
		},
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ message: child }) => {
			const next = Chart.update(model.chart, child)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) => Message.GotChartMessage({ message })),
			}
		},
	})
