import type { V2GcpConnector, V2GcpIntegration } from "@maple/domain/http/v2"
import type { GcpConnectorId } from "@maple/primitives"
import { gcpNothingSeen, gcpScopeLabel } from "../connector-state"
import { encodeLogAttributeFilter } from "@maple/views/lib/log-attribute-filters"
import { Option, Array as Arr } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import { resolveWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route/index"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import {
	DeleteConnector,
	type GcpCardModel,
	GcpMessage,
	LoadFleet,
	LoadInventory,
	LoadLogVolume,
	LoadScripts,
	ReadRemoved,
	type RemovedConnector,
	WriteRemoved,
} from "./gcp"
import { initConfigure } from "./gcp-configure"
import { disconnectSpec } from "../../../integrations/disconnect"
import type { Model } from "../../../integrations/model"
import { HubRequest, type ProviderEnv, type ProviderReturn } from "../../../integrations/provider"
import type { ConfigureTarget } from "./gcp-schema"

// The Google Cloud card's state changes (its band, menus, removal and cleanup), as module steps.

type Status = V2GcpIntegration
export type Env = ProviderEnv<Status>
export type Return = ProviderReturn<GcpCardModel, GcpMessage>
type Slot = Env["status"]

export const withCard = (model: GcpCardModel, card: Partial<GcpCardModel>): GcpCardModel => ({
	...model,
	...card,
})

/** Runs steps in order: the last step's model, every request and Command in order. */
export const steps = (model: GcpCardModel, next: ReadonlyArray<(model: GcpCardModel) => Return>): Return =>
	Arr.reduce<(typeof next)[number], Return>(next, { model }, (acc, step) => {
		const result = step(acc.model)
		return {
			model: result.model,
			requests: [...(acc.requests ?? []), ...(result.requests ?? [])],
			commands: [...(acc.commands ?? []), ...(result.commands ?? [])],
		}
	})

/** The status re-read after a write. */
export const readStatus =
	(mode: Keyed.ReadMode) =>
	(model: GcpCardModel): Return => ({ model, requests: [HubRequest.readStatus(mode)] })

export const connectorsIn = (slot: Slot): ReadonlyArray<V2GcpConnector> =>
	Option.match(AsyncData.getData(slot.data), {
		onNone: () => [],
		onSome: (status) => status.connectors,
	})

export const gcpConnectors = (model: Model): ReadonlyArray<V2GcpConnector> => connectorsIn(model.statuses.gcp)

/**
 * The card's entry: the cleanup list from storage, and a new connection for the connect flow.
 * Metrics start on until the status says the deployment lacks them.
 */
export const enterGcp = (model: GcpCardModel, env: Env): Return => ({
	model:
		model.configure === null
			? withCard(model, {
					configure: initConfigure(
						{ _tag: "New" },
						connectorsIn(env.status),
						Option.match(AsyncData.getData(env.status.data), {
							onNone: () => true,
							onSome: (status) => status.metrics_available,
						}),
					),
				})
			: model,
	commands: [ReadRemoved({ orgId: env.context.orgId })],
})

/**
 * The usage band reads once a connection has delivered, while the card shows: log volume, fleet
 * and inventory over 24 hours.
 */
export const requestBand = (model: GcpCardModel, env: Env): Return => {
	const connectors = connectorsIn(env.status)
	const logs = Arr.some(connectors, (connector) => connector.last_log_received_at !== null)
	const metrics = Arr.some(connectors, (connector) => connector.last_metrics_received_at !== null)
	if (!env.isShown || (!logs && !metrics) || env.nowMs === 0) return { model }
	const context = env.context
	const window =
		model.window ?? resolveWindow({ preset: "24h", snap: true, timeZone: context.timeZone }, env.nowMs)
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
			? take(model.logVolume, volumeKey, () => LoadLogVolume({ key: volumeKey, window }))
			: model.logVolume,
		fleet: metrics
			? take(model.fleet, fleetKey, () => LoadFleet({ key: fleetKey, window }))
			: model.fleet,
		inventory: metrics
			? take(model.inventory, inventoryKey, () => LoadInventory({ key: inventoryKey }))
			: model.inventory,
	})
	return { model: next, commands }
}

export const gotWorkloadFilter = (model: GcpCardModel, message: ToggleGroup.Message): Return => {
	const step = ToggleGroup.update(model.workloadFilter, message)
	return {
		model: withCard(model, {
			workloadFilter: step.model.values.length === 0 ? { ...step.model, values: ["all"] } : step.model,
		}),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			GcpMessage.GotWorkloadFilterMessage({ message: inner }),
		),
	}
}

const disconnectStep = (model: GcpCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { disconnectDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		GcpMessage.GotGcpDisconnectDialogMessage({ message }),
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

/** A plain confirmation for a connection never reported, else the cleanup dialog reading its scripts. */
const openDisconnect = (model: GcpCardModel, env: Env, connector: V2GcpConnector): Return => {
	const quiet = neverReported(connector)
	const key = requestKey(env.context.orgId, "gcpIntegration.setupScripts", { id: connector.id })
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
	model: GcpCardModel,
	env: Env,
	id: GcpConnectorId,
	message: Menu.Message,
	/** Passed in: `update-gcp-configure.ts` imports this module. */
	openConfigure: (model: GcpCardModel, target: ConfigureTarget) => Return,
): Return => {
	const menuId = `gcp-connection-menu-${id}`
	const step = Menu.update(model.menus[menuId] ?? Menu.init(menuId), message)
	const next = withCard(model, { menus: { ...model.menus, [menuId]: step.model } })
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		GcpMessage.GotGcpMenuMessage({ id, message: inner }),
	)
	const picked = step.outMessage?._tag === "SelectedItem" ? step.outMessage.value : null
	const found = Arr.findFirst(connectorsIn(env.status), (entry) => entry.id === id)
	if (picked === null || Option.isNone(found)) return { model: next, commands }
	const connector = found.value
	const merge = (other: Return): Return => ({
		...other,
		commands: [...commands, ...(other.commands ?? [])],
	})
	if (picked === "disconnect") return merge(openDisconnect(next, env, connector))
	if (picked === "configure") return merge(openConfigure(next, { _tag: "Connection", id, stage: "choose" }))
	if (picked === "logs" || picked === "infra")
		return merge({
			model: next,
			requests: [
				HubRequest.navigate(picked === "logs" ? gcpLogsHref(connector) : gcpInfraHref(connector)),
			],
		})
	return { model: next, commands }
}

/** The removal dialog for a connector by id, opened from outside its menu (a source's Delete). */
export const clickedDisconnect = (model: GcpCardModel, env: Env, id: string): Return =>
	Option.match(
		Arr.findFirst(connectorsIn(env.status), (entry) => entry.id === id),
		{ onNone: () => ({ model }), onSome: (connector) => openDisconnect(model, env, connector) },
	)

/** "Try again" on the script read. */
export const retriedScripts = (model: GcpCardModel, env: Env): Return => {
	const id = model.disconnectId
	if (id === null) return { model }
	const key = requestKey(env.context.orgId, "gcpIntegration.setupScripts", { id })
	return Option.match(Keyed.request(model.scripts, key, "Refresh"), {
		onNone: () => ({ model }),
		onSome: (scripts) => ({ model: withCard(model, { scripts }), commands: [LoadScripts({ key, id })] }),
	})
}

export const gotDisconnectDialog = (model: GcpCardModel, message: Dialog.Message): Return =>
	model.isDisconnecting ? { model } : disconnectStep(model, Dialog.update(model.disconnectDialog, message))

export const confirmedDisconnect = (model: GcpCardModel): Return => {
	const id = model.disconnectId
	if (id === null || model.isDisconnecting) return { model }
	return { model: withCard(model, { isDisconnecting: true }), commands: [DeleteConnector({ id })] }
}

/** Kept for its cleanup script unless that script was seen to run; the dialog closes on success. */
export const completedDisconnect = (
	model: GcpCardModel,
	env: Env,
	id: GcpConnectorId,
	cleanupScript: string | null,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isDisconnecting: false })
	if (failure !== null || cleanupScript === null)
		return {
			model: settled,
			requests: [HubRequest.toast("error", disconnectSpec("gcp").error, failure?.message ?? "")],
		}
	const removed: ReadonlyArray<RemovedConnector> = Option.match(
		Arr.findFirst(connectorsIn(env.status), (entry) => entry.id === id),
		{
			onNone: () => settled.removed,
			onSome: (connector) =>
				connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false
					? settled.removed
					: [
							...settled.removed,
							{
								id: connector.id,
								label: gcpScopeLabel(connector),
								hostProjectId: connector.project_id,
								cleanupScript,
								reported: !gcpNothingSeen(connector),
							},
						],
		},
	)
	return steps(withCard(settled, { removed, disconnectId: null }), [
		(next) => disconnectStep(next, Dialog.close(next.disconnectDialog)),
		(next) => ({ model: next, commands: [WriteRemoved({ orgId: env.context.orgId, removed })] }),
		readStatus("Supersede"),
		// The band's resource inventory is a read of its own.
		refreshInventory,
		(next) => ({ model: next, requests: [HubRequest.trackDisconnected("gcp")] }),
	])
}

export const refreshInventory = (model: GcpCardModel): Return => {
	const key = model.inventory.key
	if (key === null) return { model }
	return Option.match(Keyed.request(model.inventory, key, "Refresh"), {
		onNone: () => ({ model }),
		onSome: (inventory) => ({
			model: withCard(model, { inventory }),
			commands: [LoadInventory({ key })],
		}),
	})
}

const dismissStep = (model: GcpCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { dismissDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		GcpMessage.GotGcpDismissDialogMessage({ message }),
	),
})

export const clickedDismiss = (model: GcpCardModel, id: string): Return =>
	dismissStep(withCard(model, { dismissingId: id }), Dialog.open(model.dismissDialog))

export const gotDismissDialog = (model: GcpCardModel, message: Dialog.Message): Return =>
	dismissStep(model, Dialog.update(model.dismissDialog, message))

export const confirmedDismiss = (model: GcpCardModel, env: Env): Return => {
	const removed = Arr.filter(model.removed, (entry) => entry.id !== model.dismissingId)
	return steps(withCard(model, { removed, dismissingId: null }), [
		(next) => dismissStep(next, Dialog.close(next.dismissDialog)),
		(next) => ({ model: next, commands: [WriteRemoved({ orgId: env.context.orgId, removed })] }),
	])
}

export const gotCopy = (model: GcpCardModel, id: string, message: CopyButton.Message): Return => {
	const step = CopyButton.update(model.copies[id] ?? CopyButton.init(), message)
	return {
		model: withCard(model, { copies: { ...model.copies, [id]: step.model } }),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			GcpMessage.GotGcpCopyMessage({ id, message: inner }),
		),
	}
}
