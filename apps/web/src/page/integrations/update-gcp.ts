import type { V2GcpConnector } from "@maple/domain/http/v2"
import type { GcpConnectorId } from "@maple/domain/primitives"
import { gcpNothingSeen, gcpScopeLabel } from "../../components/integrations/gcp-connector-state"
import { encodeLogAttributeFilter } from "../../lib/logs/log-attribute-filters"
import { Option } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import { resolveWindow } from "../../data/time-range"
import { AppRoute, hrefOf } from "../../route"
import * as CopyButton from "../../ui/copy-button"
import * as Dialog from "../../ui/dialog"
import * as Menu from "../../ui/menu"
import * as ToggleGroup from "../../ui/toggle-group"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import {
	DeleteConnector,
	type GcpCardModel,
	LoadFleet,
	LoadInventory,
	LoadLogVolume,
	LoadScripts,
	ReadRemoved,
	type RemovedConnector,
	WriteRemoved,
} from "./gcp"
import { Message } from "./message"
import type { Model } from "./model"
import type { ConfigureTarget } from "./gcp-schema"
import { chain, requestStatus } from "./update-status"

// `GcpIntegrationCard`'s state changes.

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<GcpCardModel>): Model => ({
	...model,
	gcpCard: { ...model.gcpCard, ...card },
})

export const gcpConnectors = (model: Model): ReadonlyArray<V2GcpConnector> =>
	Option.match(AsyncData.getData(model.statuses.gcp.data), {
		onNone: () => [],
		onSome: (status) => status.connectors,
	})

/** The card's entry: the cleanup list from storage. */
export const enterGcp = (model: Model, context: PageContext): Return => ({
	model,
	commands: [ReadRemoved({ orgId: context.orgId })],
})

/**
 * `GcpUsageBand` mounts once a connection has delivered: the log volume, the fleet and the
 * inventory over the last 24 hours.
 */
export const requestBand = (model: Model, context: PageContext): Return => {
	const connectors = gcpConnectors(model)
	const logs = connectors.some((connector) => connector.last_log_received_at !== null)
	const metrics = connectors.some((connector) => connector.last_metrics_received_at !== null)
	if ((!logs && !metrics) || model.nowMs === 0) return { model }
	const window =
		model.gcpCard.window ??
		resolveWindow({ preset: "24h", snap: true, timeZone: context.timeZone }, model.nowMs)
	const card = model.gcpCard
	const commands: Array<NonNullable<Return["commands"]>[number]> = []
	const take = <A, E>(slot: Keyed.Keyed<A, E>, key: string, fetch: () => (typeof commands)[number]) =>
		Option.match(Keyed.request(slot, key, "Load"), {
			onNone: () => slot,
			onSome: (next) => {
				commands.push(fetch())
				return next
			},
		})
	const volumeKey = requestKey(context.orgId, "getCustomChartTimeSeries:gcpLogs", window)
	const fleetKey = requestKey(context.orgId, "gcpInfraFleet", window)
	const inventoryKey = requestKey(context.orgId, "integrations.gcpResources", {})
	const next = withCard(model, {
		window,
		logVolume: logs
			? take(card.logVolume, volumeKey, () => LoadLogVolume({ key: volumeKey, window }))
			: card.logVolume,
		fleet: metrics ? take(card.fleet, fleetKey, () => LoadFleet({ key: fleetKey, window })) : card.fleet,
		inventory: metrics
			? take(card.inventory, inventoryKey, () => LoadInventory({ key: inventoryKey }))
			: card.inventory,
	})
	return { model: next, commands }
}

export const gotWorkloadFilter = (model: Model, message: ToggleGroup.Message): Return => {
	const step = ToggleGroup.update(model.gcpCard.workloadFilter, message)
	return {
		model: withCard(model, {
			workloadFilter: step.model.values.length === 0 ? { ...step.model, values: ["all"] } : step.model,
		}),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotWorkloadFilterMessage({ message: inner }),
		),
	}
}

const disconnectStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { disconnectDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotGcpDisconnectDialogMessage({ message }),
	),
})

/** No setup reported and no data arrived: as far as Maple knows, nothing exists in Google Cloud. */
export const neverReported = (connector: V2GcpConnector): boolean => gcpNothingSeen(connector)

/** The logs this connection forwarded: ingest stamps each with the connection's id. */
export const gcpLogsHref = (connector: V2GcpConnector): string =>
	hrefOf(
		AppRoute.Logs({
			search: {
				attrs: [
					encodeLogAttributeFilter({
						source: "resource",
						key: "maple_gcp_connector_id",
						value: connector.id,
						negated: false,
					}),
				],
			},
		}),
	)

/** The infrastructure page, narrowed to the project when the connection is one. */
export const gcpInfraHref = (connector: V2GcpConnector): string =>
	hrefOf(
		AppRoute.InfraGcp({
			search: connector.scope_type === "project" ? { project: connector.scope_id } : {},
		}),
	)

/** `ConfirmDialog` for a connection never reported, else `GcpDisconnectDialog` reading its scripts. */
const openDisconnect = (model: Model, context: PageContext, connector: V2GcpConnector): Return => {
	const quiet = neverReported(connector)
	const key = requestKey(context.orgId, "gcpIntegration.setupScripts", { id: connector.id })
	const scripts: GcpCardModel["scripts"] = { key, data: AsyncData.Loading() }
	const opened = disconnectStep(
		withCard(model, {
			disconnectId: connector.id,
			isScriptShown: false,
			scripts: quiet ? Keyed.idle() : scripts,
		}),
		Dialog.open(Dialog.init("gcp-disconnect", quiet ? "alert-dialog" : "dialog")),
	)
	return quiet
		? opened
		: { ...opened, commands: [...(opened.commands ?? []), LoadScripts({ key, id: connector.id })] }
}

export const gotMenu = (
	model: Model,
	context: PageContext,
	id: GcpConnectorId,
	message: Menu.Message,
	/** `GcpConfigure` on the connection (`update-gcp-configure.ts`, which reads this module). */
	openConfigure: (model: Model, target: ConfigureTarget) => Return,
): Return => {
	const menuId = `gcp-connection-menu-${id}`
	const step = Menu.update(model.gcpCard.menus[menuId] ?? Menu.init(menuId), message)
	const next = withCard(model, { menus: { ...model.gcpCard.menus, [menuId]: step.model } })
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		Message.GotGcpMenuMessage({ id, message: inner }),
	)
	const picked = step.outMessage?._tag === "SelectedItem" ? step.outMessage.value : null
	const connector = gcpConnectors(model).find((entry) => entry.id === id)
	if (picked === null || connector === undefined) return { model: next, commands }
	const merge = (other: Return): Return => ({
		...other,
		commands: [...commands, ...(other.commands ?? [])],
	})
	if (picked === "disconnect") return merge(openDisconnect(next, context, connector))
	if (picked === "configure") return merge(openConfigure(next, { _tag: "Connection", id, stage: "choose" }))
	if (picked === "logs" || picked === "infra")
		return merge({
			model: next,
			outMessage: PageOutMessage.RequestedNavigation({
				url: picked === "logs" ? gcpLogsHref(connector) : gcpInfraHref(connector),
				isReplace: false,
			}),
		})
	return { model: next, commands }
}

/** The removal dialog for a connector by id, opened from outside its menu (a source's Delete). */
export const clickedDisconnect = (model: Model, context: PageContext, id: string): Return => {
	const connector = gcpConnectors(model).find((entry) => entry.id === id)
	return connector === undefined ? { model } : openDisconnect(model, context, connector)
}

/** "Try again" on the script read. */
export const retriedScripts = (model: Model, context: PageContext): Return => {
	const id = model.gcpCard.disconnectId
	if (id === null) return { model }
	const key = requestKey(context.orgId, "gcpIntegration.setupScripts", { id })
	return Option.match(Keyed.request(model.gcpCard.scripts, key, "Refresh"), {
		onNone: () => ({ model }),
		onSome: (scripts) => ({ model: withCard(model, { scripts }), commands: [LoadScripts({ key, id })] }),
	})
}

export const gotDisconnectDialog = (model: Model, message: Dialog.Message): Return =>
	model.gcpCard.isDisconnecting
		? { model }
		: disconnectStep(model, Dialog.update(model.gcpCard.disconnectDialog, message))

export const confirmedDisconnect = (model: Model): Return => {
	const id = model.gcpCard.disconnectId
	if (id === null || model.gcpCard.isDisconnecting) return { model }
	return { model: withCard(model, { isDisconnecting: true }), commands: [DeleteConnector({ id })] }
}

/** Kept for its cleanup script unless that script was seen to run; the dialog closes on success. */
export const completedDisconnect = (
	model: Model,
	context: PageContext,
	id: GcpConnectorId,
	cleanupScript: string | null,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isDisconnecting: false })
	if (failure !== null || cleanupScript === null)
		return {
			model: settled,
			outMessage: PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to disconnect",
				description: failure?.message ?? "",
			}),
		}
	const connector = gcpConnectors(model).find((entry) => entry.id === id)
	const neverReported = connector !== undefined && gcpNothingSeen(connector)
	const cleanedUp =
		connector !== undefined &&
		connector.applied_logs_enabled === false &&
		connector.applied_metrics_enabled === false
	const removed: ReadonlyArray<RemovedConnector> =
		connector === undefined || cleanedUp
			? settled.gcpCard.removed
			: [
					...settled.gcpCard.removed,
					{
						id: connector.id,
						label: gcpScopeLabel(connector),
						hostProjectId: connector.project_id,
						cleanupScript,
						reported: !neverReported,
					},
				]
	return chain(withCard(settled, { removed, disconnectId: null }), [
		(next) => disconnectStep(next, Dialog.close(next.gcpCard.disconnectDialog)),
		(next) => ({ model: next, commands: [WriteRemoved({ orgId: context.orgId, removed })] }),
		(next) => requestStatus(next, context, "gcp", "Supersede"),
		// `GCP_REACTIVITY_KEYS` also covers the resource inventory the band reads.
		(next) => refreshInventory(next),
	])
}

export const refreshInventory = (model: Model): Return => {
	const key = model.gcpCard.inventory.key
	if (key === null) return { model }
	return Option.match(Keyed.request(model.gcpCard.inventory, key, "Refresh"), {
		onNone: () => ({ model }),
		onSome: (inventory) => ({
			model: withCard(model, { inventory }),
			commands: [LoadInventory({ key })],
		}),
	})
}

const dismissStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { dismissDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotGcpDismissDialogMessage({ message }),
	),
})

export const clickedDismiss = (model: Model, id: string): Return =>
	dismissStep(withCard(model, { dismissingId: id }), Dialog.open(model.gcpCard.dismissDialog))

export const gotDismissDialog = (model: Model, message: Dialog.Message): Return =>
	dismissStep(model, Dialog.update(model.gcpCard.dismissDialog, message))

export const confirmedDismiss = (model: Model, context: PageContext): Return => {
	const removed = model.gcpCard.removed.filter((entry) => entry.id !== model.gcpCard.dismissingId)
	return chain(withCard(model, { removed, dismissingId: null }), [
		(next) => dismissStep(next, Dialog.close(next.gcpCard.dismissDialog)),
		(next) => ({ model: next, commands: [WriteRemoved({ orgId: context.orgId, removed })] }),
	])
}

export const gotCopy = (model: Model, id: string, message: CopyButton.Message): Return => {
	const step = CopyButton.update(model.gcpCard.copies[id] ?? CopyButton.init(), message)
	return {
		model: withCard(model, { copies: { ...model.gcpCard.copies, [id]: step.model } }),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotGcpCopyMessage({ id, message: inner }),
		),
	}
}

export const updateGcpCard = (model: Model, card: Partial<GcpCardModel>): Return => ({
	model: withCard(model, card),
})
