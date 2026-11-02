import type { UptimeMonitorId } from "@maple/domain"
import type { AlertDestinationId, AlertRuleId } from "@maple/domain/http"
import { buildDestinationUpdateParamsV2, destinationToFormState } from "@maple/web-data/alerts/form-utils"
import { rowToAlertDestinationDocument, rowToAlertRuleDocument } from "@maple/web-data/collections/alerts"
import { Array, Option, Result } from "effect"
import { AsyncData } from "foldkit"
import type { Command } from "foldkit"
import { Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import type { AppRoute } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as DestinationDialog from "../destination/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { alertsHref, createHref, ruleHref } from "../shared/links"
import { editMonitorHref, newMonitorHref, UPTIME_LIST_LIMIT } from "../shared/uptime-commands"
import {
	DeleteDestination,
	DeleteMonitor,
	FetchHubMonitors,
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
		isAdmin: false,
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
	}
	const deliveries = requestDeliveries(model, context, "Load")
	const routing = requestRoutingDeliveries(deliveries.model, context, "Load")
	const monitors = requestMonitors(routing.model, context, "Load")
	return {
		model: monitors.model,
		commands: [
			ReadHubClock(),
			FetchHubSession({ orgId: context.orgId }),
			...deliveries.commands,
			...routing.commands,
			...monitors.commands,
		],
	}
}

export const routeChanged = (model: Model, route: HubRoute, context: PageContext): Return => {
	const routing = requestRoutingDeliveries({ ...model, search: route.search }, context, "Load")
	const monitors = requestMonitors(routing.model, context, "Load")
	return { model: monitors.model, commands: [...routing.commands, ...monitors.commands] }
}

const navigate = (search: Model["search"]): PageOutMessage =>
	PageOutMessage.RequestedNavigation({ url: alertsHref(search), isReplace: false })

const toast = (type: "success" | "error", title: string, description = ""): PageOutMessage =>
	PageOutMessage.RequestedToast({ type, title, description })

const errorToast = (title: string, failure: LoadFailure): PageOutMessage =>
	toast("error", title, failure.message)

const withoutId = <A extends string>(ids: ReadonlyArray<A>, id: A): ReadonlyArray<A> =>
	ids.filter((existing) => existing !== id)

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

// ROW MENUS

/**
 * Row menu ids carry what they act on: `rule:<id>@<tag group>` (a rule is listed under each of
 * its tags) or `destination:<id>`.
 */
export const ruleMenuId = (ruleId: AlertRuleId, groupKey: string) => `rule:${ruleId}@${groupKey}`
export const destinationMenuId = (destinationId: AlertDestinationId) => `destination:${destinationId}`
export const monitorMenuId = (monitorId: UptimeMonitorId) => `monitor:${monitorId}`

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

/** "New rule" chevron: the telemetry rule editor or the uptime check form. */
const updateNewRuleMenu = (model: Model, message: Menu.Message): Return => {
	const result = Menu.update(model.newRuleMenu, message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotNewRuleMenuMessage({ message: child }),
	)
	const next = { ...model, newRuleMenu: result.model }
	if (result.outMessage?._tag !== "SelectedItem") return { model: next, commands }
	const serviceName = model.search.serviceName
	const url =
		result.outMessage.value === "uptime" ? newMonitorHref({ serviceName }) : createHref({ serviceName })
	return {
		model: next,
		commands,
		outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
	}
}

const pickedFromMenu = (model: Model, menuId: string, value: string): Return => {
	const [kind, ...rest] = menuId.split(":")
	const target = rest.join(":")
	if (kind === "monitor") return pickedMonitorAction(model, target, value)
	if (kind === "rule") {
		const id = target.split("@")[0]
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

const updateMenu = (model: Model, menuId: string, message: Menu.Message): Return => {
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
			const after = pickedFromMenu(next, menuId, value)
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
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
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
		CompletedFetchSession: ({ orgId, isAdmin }) =>
			orgId === context.orgId ? { model: { ...model, isAdmin } } : { model },
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
		GotRowMenuMessage: ({ menuId, message: child }) => updateMenu(model, menuId, child),
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
		CompletedToggleMonitor: ({ monitorId, result }) => {
			const settled = {
				...model,
				togglingMonitorIds: model.togglingMonitorIds.filter((id) => id !== monitorId),
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
