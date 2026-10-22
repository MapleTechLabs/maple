import type { AlertDestinationId, AlertRuleId } from "@maple/domain/http"
import { buildDestinationUpdateParamsV2, destinationToFormState } from "@maple/web-data/alerts/form-utils"
import { rowToAlertDestinationDocument, rowToAlertRuleDocument } from "@maple/web-data/collections/alerts"
import { Array, Option, Result } from "effect"
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
import { alertsHref, ruleHref } from "../shared/links"
import {
	DeleteDestination,
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
	}
	const deliveries = requestDeliveries(model, context, "Load")
	const routing = requestRoutingDeliveries(deliveries.model, context, "Load")
	return {
		model: routing.model,
		commands: [
			ReadHubClock(),
			FetchHubSession({ orgId: context.orgId }),
			...deliveries.commands,
			...routing.commands,
		],
	}
}

export const routeChanged = (model: Model, route: HubRoute, context: PageContext): Return =>
	requestRoutingDeliveries({ ...model, search: route.search }, context, "Load")

const navigate = (search: Model["search"]): PageOutMessage =>
	PageOutMessage.RequestedNavigation({ url: alertsHref(search), isReplace: false })

const toast = (type: "success" | "error", title: string, description = ""): PageOutMessage =>
	PageOutMessage.RequestedToast({ type, title, description })

const errorToast = (title: string, failure: LoadFailure): PageOutMessage =>
	toast("error", title, failure.message)

const withoutId = <A extends string>(ids: ReadonlyArray<A>, id: A): ReadonlyArray<A> =>
	ids.filter((existing) => existing !== id)

const destinationById = (model: Model, id: AlertDestinationId) =>
	Option.map(
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

const pickedFromMenu = (model: Model, menuId: string, value: string): Return => {
	const [kind, ...rest] = menuId.split(":")
	const target = rest.join(":")
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
		Option.map(
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
					outMessage: errorToast("Failed to update destination", failure),
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
					onFailure: (failure) => errorToast("Failed to send test notification", failure),
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
					outMessage: errorToast("Failed to delete destination", failure),
				}),
			})
		},
		ClickedNewDestination: () =>
			liftDestinationDialog(model, DestinationDialog.openNew(model.destinationDialog)),
		GotDestinationDialogMessage: ({ message: child }) =>
			liftDestinationDialog(model, DestinationDialog.update(model.destinationDialog, child)),
		GotRowMenuMessage: ({ menuId, message: child }) => updateMenu(model, menuId, child),
	})
