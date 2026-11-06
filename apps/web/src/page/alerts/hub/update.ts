import type { UptimeMonitorId } from "@maple/domain"
import type { AlertDestinationId, AlertRuleId, EscalationChainId, OnCallScheduleId } from "@maple/domain/http"
import type { V2EscalationChain, V2OnCallSchedule } from "@maple/domain/http/v2"
import { buildDestinationUpdateParamsV2, destinationToFormState } from "@maple/web-data/alerts/form-utils"
import { rowToAlertDestinationDocument, rowToAlertRuleDocument } from "@maple/web-data/collections/alerts"
import { Array, Option, Result, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Command } from "foldkit"
import { Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import type { Resources } from "../../../platform/resources"
import type { AppRoute } from "../../../route"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as DestinationDialog from "../destination/dialog"
import * as ChainDialog from "../escalation-dialog/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { alertsHref, createHref, ruleHref } from "../shared/links"
import { CHAIN_IN_USE_CODE, CHAIN_LIST_LIMIT } from "../shared/escalation-chains"
import {
	editScheduleHref,
	handoffMs,
	SCHEDULE_IN_USE_CODE,
	SCHEDULE_LIST_LIMIT,
} from "../shared/oncall-schedules"
import { newSloHref, SLO_LIST_LIMIT } from "../shared/slo-commands"
import { editMonitorHref, newMonitorHref, UPTIME_LIST_LIMIT } from "../shared/uptime-commands"
import {
	DeleteSchedule,
	FetchHubMembers,
	FetchHubSchedules,
	DeleteChain,
	DeleteDestination,
	FetchHubChains,
	DeleteMonitor,
	FetchHubMonitors,
	FetchHubSlos,
	FetchServiceNamespaces,
	ToggleMonitor,
	FetchHubDeliveries,
	FetchHubSession,
	FetchRoutingDeliveries,
	ReadHubClock,
	TestDestination,
	ToggleRule,
	UpdateDestination,
} from "./command"
import { resolveStatus, resolveTab } from "./derive"
import { Message, type RuleBucket } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type Requested = Readonly<{ model: Model; commands: Commands }>
type HubRoute = Extract<AppRoute, { readonly _tag: "Alerts" }>

const DELETE_DIALOG_ID = "alerts-delete-destination"
const DELETE_MONITOR_DIALOG_ID = "alerts-delete-monitor"
const DELETE_CHAIN_DIALOG_ID = "alerts-delete-chain"
export const DELETE_SCHEDULE_DIALOG_ID = "alerts-delete-schedule"
export const CHAIN_DIALOG_ID = "alerts-escalation-chain"
export const NEW_RULE_MENU_ID = "alerts-new-rule-menu"

/** Runs the delete dialog's update; `Closed` (Escape, Cancel, success) forgets the target. */
const updateDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteDialog: step.model,
		confirmDeleteId: step.outMessage?._tag === "Closed" ? null : model.confirmDeleteId,
	},
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const deliveriesKey = (context: PageContext) =>
	requestKey(context.orgId, "alertDeliveries.list", { query: { limit: 100 } })

/** One `Keyed.request` on the deliveries slot; `Refresh` is the `alertDeliveryEvents` invalidation. */
const requestDeliveries = (model: Model, context: PageContext, mode: Keyed.RequestMode): Requested => {
	const key = deliveriesKey(context)
	return Option.match(Keyed.request(model.deliveries, key, mode), {
		onNone: () => ({ model, commands: [] }),
		onSome: (deliveries) => ({
			model: { ...model, deliveries },
			commands: [FetchHubDeliveries({ key })],
		}),
	})
}

/** The Routing tab mounts its own deliveries read; the overview's stays mounted with the tab counts. */
const requestRoutingDeliveries = (model: Model, context: PageContext, mode: Keyed.RequestMode): Requested => {
	const key = deliveriesKey(context)
	return resolveTab(model.search.tab) !== "routing"
		? { model, commands: [] }
		: Option.match(Keyed.request(model.routingDeliveries, key, mode), {
				onNone: () => ({ model, commands: [] }),
				onSome: (routingDeliveries) => ({
					model: { ...model, routingDeliveries },
					commands: [FetchRoutingDeliveries({ key })],
				}),
			})
}

const monitorsKey = (context: PageContext) =>
	requestKey(context.orgId, "uptimeMonitors.list", { query: { limit: UPTIME_LIST_LIMIT } })

const serviceNamespacesKey = (context: PageContext) =>
	requestKey(context.orgId, "serviceOverview.namespaces", { window: "24h" })

/** Read once per visit: a namespace changes far less often than the monitors refresh. */
const requestServiceNamespaces = (model: Model, context: PageContext): Requested =>
	Option.match(Keyed.requestFor(model.serviceNamespaces, serviceNamespacesKey(context), "Load"), {
		onNone: () => ({ model, commands: [] }),
		onSome: (serviceNamespaces) => ({
			model: { ...model, serviceNamespaces },
			commands: [FetchServiceNamespaces({ key: serviceNamespaces.key })],
		}),
	})

/** The Uptime tab reads the monitors, and the namespaces they group by, only while it is open. */
const requestMonitors = (model: Model, context: PageContext, mode: Keyed.ReadMode): Requested => {
	if (resolveTab(model.search.tab) !== "uptime") return { model, commands: [] }
	const namespaces = requestServiceNamespaces(model, context)
	return Option.match(Keyed.requestFor(namespaces.model.monitors, monitorsKey(context), mode), {
		onNone: () => namespaces,
		onSome: (monitors) => ({
			model: { ...namespaces.model, monitors },
			commands: [...namespaces.commands, FetchHubMonitors({ key: monitors.key })],
		}),
	})
}

const slosKey = (context: PageContext) =>
	requestKey(context.orgId, "slos.listWithStatus", { query: { limit: SLO_LIST_LIMIT } })

/** The SLOs tab reads the SLOs and their statuses only while it is open. */
const requestSlos = (model: Model, context: PageContext, mode: Keyed.ReadMode): Requested => {
	if (resolveTab(model.search.tab) !== "slos") return { model, commands: [] }
	return Option.match(Keyed.requestFor(model.slos, slosKey(context), mode), {
		onNone: () => ({ model, commands: [] }),
		onSome: (slos) => ({ model: { ...model, slos }, commands: [FetchHubSlos({ key: slos.key })] }),
	})
}

const chainsKey = (context: PageContext) =>
	requestKey(context.orgId, "escalationChains.list", { query: { limit: CHAIN_LIST_LIMIT } })

/** The Routing tab reads the escalation chains, and the On-call tab to name the ones paging a schedule. */
const requestChains = (model: Model, context: PageContext, mode: Keyed.ReadMode): Requested => {
	const tab = resolveTab(model.search.tab)
	if (tab !== "routing" && tab !== "oncall") return { model, commands: [] }
	return Option.match(Keyed.requestFor(model.chains, chainsKey(context), mode), {
		onNone: () => ({ model, commands: [] }),
		onSome: (chains) => ({
			model: { ...model, chains },
			commands: [FetchHubChains({ key: chains.key })],
		}),
	})
}

const schedulesKey = (context: PageContext) =>
	requestKey(context.orgId, "oncallSchedules.list", { query: { limit: SCHEDULE_LIST_LIMIT } })

/** Every tab reads the schedules: the inbox strip, the On-call tab and the chain dialog's targets. */
const requestSchedules = (model: Model, context: PageContext, mode: Keyed.ReadMode): Requested =>
	Option.match(Keyed.requestFor(model.schedules, schedulesKey(context), mode), {
		onNone: () => ({ model, commands: [] }),
		onSome: (schedules) => ({
			model: { ...model, schedules },
			commands: [FetchHubSchedules({ key: schedules.key })],
		}),
	})

/** Re-read at most every 5 minutes, and at once when a shift the list shows has handed off. */
const SCHEDULES_MAX_AGE_MS = 5 * 60_000

const schedulesOf = (model: Model): ReadonlyArray<V2OnCallSchedule> =>
	Option.getOrElse(AsyncData.getData(model.schedules.data), () => [])

const isSchedulesStale = (model: Model, nowMs: number): boolean => {
	const readAt = model.schedules.updatedAtMs
	if (readAt === undefined || !AsyncData.isSuccess(model.schedules.data)) return false
	return (
		nowMs - readAt >= SCHEDULES_MAX_AGE_MS ||
		Array.some(schedulesOf(model), (schedule) => Option.exists(handoffMs(schedule), (at) => at <= nowMs))
	)
}

/** The clock ticked: the overview's derivation moves, and stale schedules are read again. */
const clockRead = (model: Model, context: PageContext, nowMs: number): Return => {
	const next = { ...model, nowMs }
	if (!isSchedulesStale(next, nowMs)) return { model: next }
	const step = requestSchedules(next, context, "Refresh")
	return { model: step.model, commands: step.commands }
}

/** `reactivityKeys: ["alertDeliveryEvents"]`: both reads revalidate. */
const refreshDeliveries = (model: Model, context: PageContext) => {
	const overview = requestDeliveries(model, context, "Refresh")
	const routing = requestRoutingDeliveries(overview.model, context, "Refresh")
	return { model: routing.model, commands: [...overview.commands, ...routing.commands] }
}

export const init = (route: HubRoute, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		nowMs: null,
		rules: null,
		states: null,
		incidents: null,
		destinations: null,
		deliveries: Keyed.idle(),
		routingDeliveries: Keyed.idle(),
		grants: [],
		rulesQuery: "",
		isShowingAllRules: false,
		togglingRuleId: null,
		hasToggleFailed: false,
		isLoadFailed: false,
		testingDestinationIds: [],
		deletingDestinationIds: [],
		confirmDeleteId: null,
		deleteDialog: Dialog.init(DELETE_DIALOG_ID, "alert-dialog"),
		brokenLogos: [],
		menus: {},
		destinationDialog: DestinationDialog.init("alerts-destination"),
		newRuleMenu: Menu.init(NEW_RULE_MENU_ID),
		monitors: Keyed.idle(),
		serviceNamespaces: Keyed.idle(),
		uptimeQuery: "",
		uptimeStatus: "all",
		uptimeKind: "all",
		togglingMonitorIds: [],
		deletingMonitorId: null,
		confirmDeleteMonitorId: null,
		deleteMonitorDialog: Dialog.init(DELETE_MONITOR_DIALOG_ID, "alert-dialog"),
		slos: Keyed.idle(),
		chains: Keyed.idle(),
		chainDialog: ChainDialog.init(CHAIN_DIALOG_ID),
		confirmDeleteChainId: null,
		deletingChainId: null,
		deleteChainError: null,
		deleteChainDialog: Dialog.init(DELETE_CHAIN_DIALOG_ID, "alert-dialog"),
		schedules: Keyed.idle(),
		members: null,
		confirmDeleteScheduleId: null,
		deletingScheduleId: null,
		deleteScheduleError: null,
		deleteScheduleDialog: Dialog.init(DELETE_SCHEDULE_DIALOG_ID, "alert-dialog"),
	}
	const deliveries = requestDeliveries(model, context, "Load")
	const routing = requestRoutingDeliveries(deliveries.model, context, "Load")
	const monitors = requestMonitors(routing.model, context, "Load")
	const slos = requestSlos(monitors.model, context, "Load")
	const chains = requestChains(slos.model, context, "Load")
	const schedules = requestSchedules(chains.model, context, "Load")
	return {
		model: schedules.model,
		commands: [
			ReadHubClock(),
			FetchHubSession({ orgId: context.orgId }),
			FetchHubMembers(),
			...schedules.commands,
			...deliveries.commands,
			...routing.commands,
			...monitors.commands,
			...slos.commands,
			...chains.commands,
		],
	}
}

export const routeChanged = (model: Model, route: HubRoute, context: PageContext): Return => {
	const routing = requestRoutingDeliveries({ ...model, search: route.search }, context, "Load")
	const monitors = requestMonitors(routing.model, context, "Load")
	const slos = requestSlos(monitors.model, context, "Load")
	const chains = requestChains(slos.model, context, "Load")
	const schedules = requestSchedules(chains.model, context, "Load")
	return {
		model: schedules.model,
		commands: [
			...routing.commands,
			...monitors.commands,
			...slos.commands,
			...chains.commands,
			...schedules.commands,
		],
	}
}

const navigate = (search: Model["search"]): PageOutMessage =>
	PageOutMessage.RequestedNavigation({ url: alertsHref(search), isReplace: false })

const toast = (type: "success" | "error", title: string, description = ""): PageOutMessage =>
	PageOutMessage.RequestedToast({ type, title, description })

const errorToast = (title: string, failure: LoadFailure): PageOutMessage =>
	toast("error", title, failure.message)

const withoutId = <A extends string>(ids: ReadonlyArray<A>, id: A): ReadonlyArray<A> =>
	Array.filter(ids, (existing) => existing !== id)

const destinationById = (model: Model, id: AlertDestinationId) =>
	Option.flatMap(
		Array.findFirst(model.destinations ?? [], (row) => row.id === id),
		rowToAlertDestinationDocument,
	)

const toggleRule = (model: Model, ruleId: AlertRuleId, isEnabled: boolean): Return =>
	// `Mutation.make` serializes the write on one permit: a second toggle waits for the first.
	model.togglingRuleId !== null
		? { model }
		: { model: { ...model, togglingRuleId: ruleId }, commands: [ToggleRule({ ruleId, isEnabled })] }

const toggleDestination = (model: Model, destinationId: AlertDestinationId): Return =>
	Option.match(destinationById(model, destinationId), {
		onNone: () => ({ model }),
		onSome: (destination) => ({
			model,
			commands: [
				UpdateDestination({
					destinationId,
					payload: buildDestinationUpdateParamsV2({
						...destinationToFormState(destination),
						enabled: !destination.enabled,
					}),
				}),
			],
		}),
	})

const testDestination = (model: Model, destinationId: AlertDestinationId): Return =>
	model.testingDestinationIds.includes(destinationId)
		? { model }
		: {
				model: { ...model, testingDestinationIds: [...model.testingDestinationIds, destinationId] },
				commands: [TestDestination({ destinationId })],
			}

const confirmDelete = (model: Model): Return => {
	const id = model.confirmDeleteId
	return id === null || model.deletingDestinationIds.includes(id)
		? { model }
		: {
				model: { ...model, deletingDestinationIds: [...model.deletingDestinationIds, id] },
				commands: [DeleteDestination({ destinationId: id })],
			}
}

// DESTINATION DIALOG

/** The dialog's outcome as the page reports it: toasts, and "Destination created" for a new one. */
const liftDestinationDialog = (model: Model, step: ReturnType<typeof DestinationDialog.update>): Return => ({
	model: { ...model, destinationDialog: step.model },
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDestinationDialogMessage({ message }),
	),
	outMessage:
		step.outMessage === undefined
			? undefined
			: DestinationDialog.OutMessage.match(step.outMessage, {
					RequestedToast: ({ type, title, description }) => toast(type, title, description),
					CreatedDestination: () => toast("success", "Destination created"),
				}),
})

// ESCALATION CHAINS

const chainsOf = (model: Model): ReadonlyArray<V2EscalationChain> =>
	Option.getOrElse(AsyncData.getData(model.chains.data), () => [])

/** A write changed the chains: read them again under a new generation. */
const refreshChains = (model: Model, context: PageContext): Return => {
	const step = requestChains(model, context, "Supersede")
	return { model: step.model, commands: step.commands }
}

/** The chain dialog's outcome: a toast, and the list read again. */
const liftChainDialog = (
	model: Model,
	context: PageContext,
	step: ReturnType<typeof ChainDialog.update>,
): Return => {
	const lifted: Model = { ...model, chainDialog: step.model }
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotChainDialogMessage({ message }),
	)
	if (step.outMessage === undefined) return { model: lifted, commands }
	const refreshed = refreshChains(lifted, context)
	return {
		model: refreshed.model,
		commands: [...commands, ...(refreshed.commands ?? [])],
		outMessage: toast(
			"success",
			step.outMessage.isNew ? "Escalation chain created" : "Escalation chain saved",
		),
	}
}

/** The names of the rules a chain says use it, from the synced rules. */
export const chainRuleNames = (
	model: Pick<Model, "rules">,
	chain: V2EscalationChain,
): ReadonlyArray<string> =>
	Array.map(chain.rule_ids, (id) =>
		Option.getOrElse(
			Option.map(
				Array.findFirst(model.rules ?? [], (row) => row.id === id),
				(row) => row.name,
			),
			() => "a rule you cannot see",
		),
	)

/** Why a delete was refused: the API's 409 names no rules, so they come from the chain's own list. */
const inUseMessage = (model: Model, chainId: EscalationChainId): string =>
	Option.match(
		Array.findFirst(chainsOf(model), (chain) => chain.id === chainId),
		{
			onNone: () => "Alert rules still start this chain. Remove it from their severity tiers first.",
			onSome: (chain) =>
				`Still used by ${Array.join(chainRuleNames(model, chain), ", ")}. Remove it from their severity tiers first.`,
		},
	)

/** Runs the chain delete dialog's update; `Closed` forgets the target and its error. */
const updateDeleteChainDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => {
	const isClosed = step.outMessage?._tag === "Closed"
	return {
		model: {
			...model,
			deleteChainDialog: step.model,
			confirmDeleteChainId: isClosed ? null : model.confirmDeleteChainId,
			deleteChainError: isClosed ? null : model.deleteChainError,
		},
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
			Message.GotDeleteChainDialogMessage({ message }),
		),
	}
}

const pickedChainAction = (model: Model, context: PageContext, rawId: string, value: string): Return =>
	Option.match(
		Array.findFirst(chainsOf(model), (chain) => chain.id === rawId),
		{
			onNone: () => ({ model }),
			onSome: (chain): Return =>
				value === "delete"
					? updateDeleteChainDialog(
							{ ...model, confirmDeleteChainId: chain.id, deleteChainError: null },
							Dialog.open(model.deleteChainDialog),
						)
					: liftChainDialog(model, context, ChainDialog.openEdit(model.chainDialog, chain)),
		},
	)

const confirmDeleteChain = (model: Model): Return => {
	const id = model.confirmDeleteChainId
	return id === null || model.deletingChainId !== null
		? { model }
		: {
				model: { ...model, deletingChainId: id, deleteChainError: null },
				commands: [DeleteChain({ chainId: id })],
			}
}

const deletedChain = (
	model: Model,
	context: PageContext,
	chainId: EscalationChainId,
	result: Result.Result<void, LoadFailure>,
): Return => {
	const settled = { ...model, deletingChainId: null }
	return Result.match(result, {
		onSuccess: (): Return => {
			const closed = updateDeleteChainDialog(settled, Dialog.close(settled.deleteChainDialog))
			const refreshed = refreshChains(closed.model, context)
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
				outMessage: toast("success", "Escalation chain deleted"),
			}
		},
		// The dialog stays open on a refusal, saying which rules hold the chain.
		onFailure: (failure): Return => ({
			model: {
				...settled,
				deleteChainError:
					failure.code === CHAIN_IN_USE_CODE ? inUseMessage(settled, chainId) : failure.message,
			},
		}),
	})
}

// ON-CALL SCHEDULES

/** A write changed the schedules: read them again under a new generation. */
const refreshSchedules = (model: Model, context: PageContext): Return => {
	const step = requestSchedules(model, context, "Supersede")
	return { model: step.model, commands: step.commands }
}

/** The chains that page a schedule, by name, for the in-use refusal. */
const scheduleChainNames = (model: Model, schedule: V2OnCallSchedule): ReadonlyArray<string> =>
	Array.flatMap(schedule.chain_ids, (id) =>
		Option.toArray(
			Option.map(
				Array.findFirst(chainsOf(model), (chain) => chain.id === id),
				(chain) => chain.name,
			),
		),
	)

const scheduleInUseMessage = (model: Model, scheduleId: OnCallScheduleId): string => {
	const names = Option.match(
		Array.findFirst(schedulesOf(model), (schedule) => schedule.id === scheduleId),
		{ onNone: () => [], onSome: (schedule) => scheduleChainNames(model, schedule) },
	)
	return names.length === 0
		? "An escalation chain still pages this schedule. Remove it from the chain first."
		: `Still paged by ${Array.join(names, ", ")}. Remove it from those chains first.`
}

/** Runs the schedule delete dialog's update; `Closed` forgets the target and its error. */
const updateDeleteScheduleDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => {
	const isClosed = step.outMessage?._tag === "Closed"
	return {
		model: {
			...model,
			deleteScheduleDialog: step.model,
			confirmDeleteScheduleId: isClosed ? null : model.confirmDeleteScheduleId,
			deleteScheduleError: isClosed ? null : model.deleteScheduleError,
		},
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
			Message.GotDeleteScheduleDialogMessage({ message }),
		),
	}
}

const pickedScheduleAction = (model: Model, rawId: string, value: string): Return =>
	Option.match(
		Array.findFirst(schedulesOf(model), (schedule) => schedule.id === rawId),
		{
			onNone: () => ({ model }),
			onSome: (schedule): Return =>
				value === "delete"
					? updateDeleteScheduleDialog(
							{ ...model, confirmDeleteScheduleId: schedule.id, deleteScheduleError: null },
							Dialog.open(model.deleteScheduleDialog),
						)
					: {
							model,
							outMessage: PageOutMessage.RequestedNavigation({
								url: editScheduleHref(schedule.id),
								isReplace: false,
							}),
						},
		},
	)

const confirmDeleteSchedule = (model: Model): Return => {
	const id = model.confirmDeleteScheduleId
	return id === null || model.deletingScheduleId !== null
		? { model }
		: {
				model: { ...model, deletingScheduleId: id, deleteScheduleError: null },
				commands: [DeleteSchedule({ scheduleId: id })],
			}
}

const deletedSchedule = (
	model: Model,
	context: PageContext,
	scheduleId: OnCallScheduleId,
	result: Result.Result<void, LoadFailure>,
): Return => {
	const settled = { ...model, deletingScheduleId: null }
	return Result.match(result, {
		onSuccess: (): Return => {
			const closed = updateDeleteScheduleDialog(settled, Dialog.close(settled.deleteScheduleDialog))
			const refreshed = refreshSchedules(closed.model, context)
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
				outMessage: toast("success", "Schedule deleted"),
			}
		},
		onFailure: (failure): Return => ({
			model: {
				...settled,
				deleteScheduleError:
					failure.code === SCHEDULE_IN_USE_CODE
						? scheduleInUseMessage(settled, scheduleId)
						: failure.message,
			},
		}),
	})
}

// ROW MENUS

/**
 * Row menu ids carry what they act on: `rule:<id>@<tag group>` (a rule is listed under each of
 * its tags) or `destination:<id>`.
 */
export const ruleMenuId = (ruleId: AlertRuleId, groupKey: string) => `rule:${ruleId}@${groupKey}`
export const destinationMenuId = (destinationId: AlertDestinationId) => `destination:${destinationId}`
export const monitorMenuId = (monitorId: UptimeMonitorId) => `monitor:${monitorId}`
export const chainMenuId = (chainId: EscalationChainId) => `chain:${chainId}`
export const scheduleMenuId = (scheduleId: OnCallScheduleId) => `schedule:${scheduleId}`

const monitorsOf = (model: Model) => Option.getOrElse(AsyncData.getData(model.monitors.data), () => [])

const toggleMonitor = (model: Model, monitorId: UptimeMonitorId, enabled: boolean): Return =>
	model.togglingMonitorIds.includes(monitorId)
		? { model }
		: {
				model: { ...model, togglingMonitorIds: [...model.togglingMonitorIds, monitorId] },
				commands: [ToggleMonitor({ monitorId, enabled })],
			}

/** Runs the monitor delete dialog's update; `Closed` forgets the target. */
const updateDeleteMonitorDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteMonitorDialog: step.model,
		confirmDeleteMonitorId: step.outMessage?._tag === "Closed" ? null : model.confirmDeleteMonitorId,
	},
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteMonitorDialogMessage({ message }),
	),
})

const pickedMonitorAction = (model: Model, rawId: string, value: string): Return =>
	Option.match(
		Array.findFirst(monitorsOf(model), (monitor) => monitor.id === rawId),
		{
			onNone: () => ({ model }),
			onSome: (monitor): Return => {
				switch (value) {
					case "toggle":
						return toggleMonitor(model, monitor.id, !monitor.enabled)
					case "edit":
						return {
							model,
							outMessage: PageOutMessage.RequestedNavigation({
								url: editMonitorHref(monitor.id),
								isReplace: false,
							}),
						}
					default:
						return updateDeleteMonitorDialog(
							{ ...model, confirmDeleteMonitorId: monitor.id },
							Dialog.open(model.deleteMonitorDialog),
						)
				}
			},
		},
	)

const confirmDeleteMonitor = (model: Model): Return => {
	const id = model.confirmDeleteMonitorId
	return id === null || model.deletingMonitorId !== null
		? { model }
		: { model: { ...model, deletingMonitorId: id }, commands: [DeleteMonitor({ monitorId: id })] }
}

/** A write changed the list: read it again under a new generation. */
const refreshMonitors = (model: Model, context: PageContext): Return => {
	const step = requestMonitors(model, context, "Supersede")
	return { model: step.model, commands: step.commands }
}

/** "New rule" chevron: the telemetry rule editor, the uptime check form or the SLO form. */
const updateNewRuleMenu = (model: Model, message: Menu.Message): Return => {
	const result = Menu.update(model.newRuleMenu, message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotNewRuleMenuMessage({ message: child }),
	)
	const next = { ...model, newRuleMenu: result.model }
	if (result.outMessage?._tag !== "SelectedItem") return { model: next, commands }
	const serviceName = model.search.serviceName
	const url =
		result.outMessage.value === "uptime"
			? newMonitorHref({ serviceName })
			: result.outMessage.value === "slo"
				? newSloHref({ serviceName })
				: createHref({ serviceName })
	return {
		model: next,
		commands,
		outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
	}
}

const pickedFromMenu = (model: Model, context: PageContext, menuId: string, value: string): Return => {
	const [kind, ...rest] = Str.split(":")(menuId)
	const target = Array.join(rest, ":")
	if (kind === "monitor") return pickedMonitorAction(model, target, value)
	if (kind === "chain") return pickedChainAction(model, context, target, value)
	if (kind === "schedule") return pickedScheduleAction(model, target, value)
	if (kind === "rule") {
		const id = Str.split("@")(target)[0]
		const rule = Option.map(
			Array.findFirst(model.rules ?? [], (row) => row.id === id),
			(row) => rowToAlertRuleDocument(row, new Map()),
		)
		return Option.match(rule, {
			onNone: () => ({ model }),
			onSome: (row) =>
				value === "open"
					? {
							model,
							outMessage: PageOutMessage.RequestedNavigation({
								url: ruleHref(row.id),
								isReplace: false,
							}),
						}
					: toggleRule(model, row.id, !row.enabled),
		})
	}
	return Option.match(
		Option.flatMap(
			Array.findFirst(model.destinations ?? [], (row) => row.id === target),
			rowToAlertDestinationDocument,
		),
		{
			onNone: () => ({ model }),
			onSome: (row) =>
				value === "delete"
					? updateDeleteDialog(
							{ ...model, confirmDeleteId: row.id },
							Dialog.open(model.deleteDialog),
						)
					: liftDestinationDialog(model, DestinationDialog.openEdit(model.destinationDialog, row)),
		},
	)
}

const updateMenu = (model: Model, context: PageContext, menuId: string, message: Menu.Message): Return => {
	const result = Menu.update(model.menus[menuId] ?? Menu.init(menuId), message)
	const next: Model = { ...model, menus: { ...model.menus, [menuId]: result.model } }
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotRowMenuMessage({ menuId, message: child }),
	)
	const picked = Option.flatMap(Option.fromNullishOr(result.outMessage), (out) =>
		out._tag === "SelectedItem" ? Option.some(out.value) : Option.none(),
	)
	return Option.match(picked, {
		onNone: () => ({ model: next, commands }),
		onSome: (value) => {
			const after = pickedFromMenu(next, context, menuId, value)
			return { ...after, commands: [...commands, ...(after.commands ?? [])] }
		},
	})
}

const statusToggled = (model: Model, bucket: RuleBucket): Return => ({
	model,
	outMessage: navigate({
		...model.search,
		status: resolveStatus(model.search.status) === bucket ? undefined : bucket,
	}),
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => clockRead(model, context, nowMs),
		UpdatedRules: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, rules: rows } } : { model },
		UpdatedRuleStates: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, states: rows } } : { model },
		UpdatedIncidents: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, incidents: rows } } : { model },
		FailedLoadAlerts: ({ orgId }) =>
			orgId === context.orgId && (model.rules === null || model.incidents === null)
				? { model: { ...model, isLoadFailed: true } }
				: { model },
		// `retryOrgCollections`: a stopped shape syncs again only on fresh collections.
		ClickedRetryLoad: () => ({
			model: { ...model, isLoadFailed: false },
			outMessage: PageOutMessage.RequestedReconnectOrgCollections(),
		}),
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		CompletedFetchDeliveries: ({ key, result }) => ({
			model: { ...model, deliveries: Keyed.accept(model.deliveries, key, result) },
		}),
		CompletedFetchRoutingDeliveries: ({ key, result }) => ({
			model: { ...model, routingDeliveries: Keyed.accept(model.routingDeliveries, key, result) },
		}),
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants } } : { model },
		ChangedRulesQuery: ({ value }) => ({ model: { ...model, rulesQuery: value } }),
		ClickedStatusFilter: ({ bucket }) => statusToggled(model, bucket),
		ClickedClearRuleFilters: () => ({
			model: { ...model, rulesQuery: "" },
			outMessage: navigate({ ...model.search, status: undefined }),
		}),
		ClickedShowAllRules: () => ({ model: { ...model, isShowingAllRules: true } }),
		ClickedToggleRule: ({ ruleId, isEnabled }) => toggleRule(model, ruleId, isEnabled),
		CompletedToggleRule: ({ result }) => ({
			model: { ...model, togglingRuleId: null, hasToggleFailed: Result.isFailure(result) },
		}),
		ClickedToggleDestination: ({ destinationId }) => toggleDestination(model, destinationId),
		CompletedUpdateDestination: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({ model }),
				onFailure: (failure) => ({
					model,
					outMessage: errorToast("Couldn't update destination", failure),
				}),
			}),
		ClickedTestDestination: ({ destinationId }) => testDestination(model, destinationId),
		CompletedTestDestination: ({ destinationId, result }) => {
			const settled = {
				...model,
				testingDestinationIds: withoutId(model.testingDestinationIds, destinationId),
			}
			// The test lands in the delivery log: `reactivityKeys: ["alertDeliveryEvents"]`.
			const refreshed = refreshDeliveries(settled, context)
			return {
				model: refreshed.model,
				commands: refreshed.commands,
				outMessage: Result.match(result, {
					onSuccess: (outcome) => toast(outcome.success ? "success" : "error", outcome.message),
					onFailure: (failure) => errorToast("Couldn't send test notification", failure),
				}),
			}
		},
		ClickedConfirmDeleteDestination: () => confirmDelete(model),
		GotDeleteDialogMessage: ({ message: child }) =>
			// `ConfirmDialog` ignores dismissal while the delete is pending.
			model.confirmDeleteId !== null && model.deletingDestinationIds.includes(model.confirmDeleteId)
				? { model }
				: updateDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
		FailedLoadProviderLogo: ({ type }) =>
			model.brokenLogos.includes(type)
				? { model }
				: { model: { ...model, brokenLogos: [...model.brokenLogos, type] } },
		CompletedDeleteDestination: ({ destinationId, result }) => {
			const settled = {
				...model,
				deletingDestinationIds: withoutId(model.deletingDestinationIds, destinationId),
			}
			return Result.match(result, {
				onSuccess: () => ({
					...updateDeleteDialog(settled, Dialog.close(settled.deleteDialog)),
					outMessage: toast("success", "Destination deleted"),
				}),
				onFailure: (failure) => ({
					model: settled,
					outMessage: errorToast("Couldn't delete destination", failure),
				}),
			})
		},
		ClickedNewDestination: () =>
			liftDestinationDialog(model, DestinationDialog.openNew(model.destinationDialog)),
		GotDestinationDialogMessage: ({ message: child }) =>
			liftDestinationDialog(model, DestinationDialog.update(model.destinationDialog, child)),
		GotRowMenuMessage: ({ menuId, message: child }) => updateMenu(model, context, menuId, child),
		GotNewRuleMenuMessage: ({ message: child }) => updateNewRuleMenu(model, child),
		CompletedFetchMonitors: ({ key, result }) => ({
			model: { ...model, monitors: Keyed.accept(model.monitors, key, result) },
		}),
		ClickedRetryMonitors: () => refreshMonitors(model, context),
		CompletedFetchServiceNamespaces: ({ key, result }) => ({
			model: { ...model, serviceNamespaces: Keyed.accept(model.serviceNamespaces, key, result) },
		}),
		ChangedUptimeQuery: ({ value }) => ({ model: { ...model, uptimeQuery: value } }),
		ClickedUptimeStatus: ({ filter }) => ({ model: { ...model, uptimeStatus: filter } }),
		ChangedUptimeKind: ({ kind }) => ({ model: { ...model, uptimeKind: kind } }),
		ClickedClearUptimeFilters: () => ({
			model: { ...model, uptimeQuery: "", uptimeStatus: "all", uptimeKind: "all" },
		}),
		CompletedFetchSlos: ({ key, result }) => ({
			model: { ...model, slos: Keyed.accept(model.slos, key, result) },
		}),
		CompletedFetchChains: ({ key, result }) => ({
			model: { ...model, chains: Keyed.accept(model.chains, key, result) },
		}),
		ClickedRetryChains: () => refreshChains(model, context),
		ClickedNewChain: () => liftChainDialog(model, context, ChainDialog.openNew(model.chainDialog)),
		GotChainDialogMessage: ({ message: child }) =>
			liftChainDialog(model, context, ChainDialog.update(model.chainDialog, child)),
		ClickedConfirmDeleteChain: () => confirmDeleteChain(model),
		CompletedDeleteChain: ({ chainId, result }) => deletedChain(model, context, chainId, result),
		GotDeleteChainDialogMessage: ({ message: child }) =>
			model.deletingChainId !== null
				? { model }
				: updateDeleteChainDialog(model, Dialog.update(model.deleteChainDialog, child)),
		CompletedFetchSchedules: ({ key, readAtMs, result }) => ({
			model: { ...model, schedules: Keyed.accept(model.schedules, key, result, readAtMs) },
		}),
		ClickedRetrySchedules: () => refreshSchedules(model, context),
		// Without members the names read "Member"; the schedules themselves still show.
		CompletedFetchMembers: ({ result }) =>
			Result.match(result, {
				onSuccess: (members) => ({ model: { ...model, members } }),
				onFailure: () => ({ model }),
			}),
		ClickedConfirmDeleteSchedule: () => confirmDeleteSchedule(model),
		CompletedDeleteSchedule: ({ scheduleId, result }) =>
			deletedSchedule(model, context, scheduleId, result),
		GotDeleteScheduleDialogMessage: ({ message: child }) =>
			model.deletingScheduleId !== null
				? { model }
				: updateDeleteScheduleDialog(model, Dialog.update(model.deleteScheduleDialog, child)),
		ClickedRetrySlos: () => {
			const step = requestSlos(model, context, "Supersede")
			return { model: step.model, commands: step.commands }
		},
		CompletedToggleMonitor: ({ monitorId, result }) => {
			const settled = {
				...model,
				togglingMonitorIds: Array.filter(model.togglingMonitorIds, (id) => id !== monitorId),
			}
			return Result.match(result, {
				onSuccess: (monitor): Return => ({
					...refreshMonitors(settled, context),
					outMessage: toast("success", monitor.enabled ? "Monitor resumed" : "Monitor paused"),
				}),
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: errorToast("Couldn't update the monitor", failure),
				}),
			})
		},
		ClickedConfirmDeleteMonitor: () => confirmDeleteMonitor(model),
		GotDeleteMonitorDialogMessage: ({ message: child }) =>
			model.deletingMonitorId !== null
				? { model }
				: updateDeleteMonitorDialog(model, Dialog.update(model.deleteMonitorDialog, child)),
		CompletedDeleteMonitor: ({ result }) => {
			const settled = { ...model, deletingMonitorId: null }
			return Result.match(result, {
				onSuccess: (): Return => {
					const closed = updateDeleteMonitorDialog(
						settled,
						Dialog.close(settled.deleteMonitorDialog),
					)
					const refreshed = refreshMonitors(closed.model, context)
					return {
						model: refreshed.model,
						commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
						outMessage: toast("success", "Monitor deleted"),
					}
				},
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: errorToast("Couldn't delete the monitor", failure),
				}),
			})
		},
	})
