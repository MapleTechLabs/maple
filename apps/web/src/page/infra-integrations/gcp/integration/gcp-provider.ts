import type { V2GcpIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { GCP_CONNECTION_LABEL, gcpConnectionState, gcpScopeLabel, gcpWorstState } from "../connector-state"
import {
	type CardStatus,
	fold,
	type IntegrationOverview,
	isoMs,
	lastSyncOf,
	maxMs,
	NOT_CONNECTED,
	SET_UP,
	unavailableOverview,
	unavailableStatus,
} from "../../../integrations/overview"
import { HubRequest, type ProviderModule, type ProviderUpdate } from "../../../integrations/provider"
import { GCP_STATUS_READ, type GcpCardModel, GcpMessage, initGcpCard } from "./gcp"
import { gcpFlow } from "./flow-gcp"
import * as Gcp from "./update-gcp"
import * as Configure from "./update-gcp-configure"
import { gcpCard, gcpHeaderStatus } from "./view-gcp"
import { gcpFlowView } from "./view-flow-gcp"

// Google Cloud's part of `/integrations` and `/sources/new`: its connections, usage band, removal
// and cleanup scripts, and the configure wizard that creates and changes a connection.

type Status = V2GcpIntegration
type Env = Gcp.Env
type Slot = Env["status"]

/** Some connection is still settling (not healthy): the status is read every 10 s, not every minute. */
const isSettling = (slot: Slot, nowMs: number): boolean =>
	Arr.some(Gcp.connectorsIn(slot), (connector) => gcpConnectionState(connector, nowMs) !== "healthy")

const update = (
	model: GcpCardModel,
	message: GcpMessage,
	env: Env,
): ProviderUpdate<GcpCardModel, GcpMessage, Status> =>
	GcpMessage.match<ProviderUpdate<GcpCardModel, GcpMessage, Status>>(message, {
		CompletedGcpLogVolume: ({ key, result }) => ({
			model: Gcp.withCard(model, { logVolume: Keyed.accept(model.logVolume, key, result) }),
		}),
		CompletedGcpFleet: ({ key, result }) => ({
			model: Gcp.withCard(model, { fleet: Keyed.accept(model.fleet, key, result) }),
		}),
		CompletedGcpInventory: ({ key, result }) => ({
			model: Gcp.withCard(model, { inventory: Keyed.accept(model.inventory, key, result) }),
		}),
		GotWorkloadFilterMessage: ({ message: child }) => Gcp.gotWorkloadFilter(model, child),
		GotGcpMenuMessage: ({ id, message: child }) =>
			Gcp.gotMenu(model, env, id, child, (next, target) => Configure.openConfigure(next, env, target)),
		CompletedGcpScripts: ({ key, result }) => ({
			model: Gcp.withCard(model, { scripts: Keyed.accept(model.scripts, key, result) }),
		}),
		ClickedGcpScriptToggle: () => ({
			model: Gcp.withCard(model, { isScriptShown: !model.isScriptShown }),
		}),
		ClickedGcpScriptRetry: () => Gcp.retriedScripts(model, env),
		GotGcpDisconnectDialogMessage: ({ message: child }) => Gcp.gotDisconnectDialog(model, child),
		ConfirmedGcpDisconnect: () => Gcp.confirmedDisconnect(model),
		ClickedGcpDisconnect: ({ id }) => Gcp.clickedDisconnect(model, env, id),
		CompletedGcpDisconnect: ({ id, cleanupScript, failure }) =>
			Gcp.completedDisconnect(model, env, id, cleanupScript, failure),
		CompletedReadGcpRemoved: ({ removed }) => ({ model: Gcp.withCard(model, { removed }) }),
		CompletedWriteGcpRemoved: () => ({ model }),
		ClickedDismissCleanup: ({ id }) => Gcp.clickedDismiss(model, id),
		GotGcpDismissDialogMessage: ({ message: child }) => Gcp.gotDismissDialog(model, child),
		ConfirmedDismissCleanup: () => Gcp.confirmedDismiss(model, env),
		GotGcpCopyMessage: ({ id, message: child }) => Gcp.gotCopy(model, id, child),
		ClickedGcpConfigure: ({ target }) => Configure.openConfigure(model, env, target),
		ClosedGcpConfigure: () => Configure.closedConfigure(model),
		GotGcpConfigureDialogMessage: ({ message: child }) => Configure.gotConfigureDialog(model, child),
		GotGcpScopeTypeMessage: ({ message: child }) => Configure.gotScopeType(model, child),
		GotGcpScopeFieldMessage: ({ field, message: child }) => Configure.gotScopeField(model, field, child),
		SubmittedGcpCreate: () => Configure.submittedCreate(model),
		ToggledGcpCollect: ({ capability }) => Configure.toggledCollect(model, env, capability),
		ToggledGcpFeature: ({ id, capability }) => Configure.toggledFeature(model, env, id, capability),
		ClickedGcpLogFilter: () => Configure.clickedLogFilter(model),
		GotGcpFilterModeMessage: ({ message: child }) => Configure.gotFilterMode(model, env, child),
		ClickedGcpForwardOutput: () => Configure.clickedForwardOutput(model, env),
		ClickedGcpUseOpenTelemetry: () => Configure.clickedUseOpenTelemetry(model, env),
		ToggledGcpRuntime: ({ runtime }) => Configure.toggledRuntime(model, env, runtime),
		CompletedGcpCreate: ({ opens, connector, failure }) =>
			Configure.completedCreate(model, env, opens, connector, failure),
		ClickedGcpChooseApply: () => Configure.clickedChooseApply(model, env),
		GotGcpConfirmDialogMessage: ({ message: child }) => Configure.gotConfirmDialog(model, child),
		ConfirmedGcpSave: () => Configure.confirmedSave(model, env),
		CompletedGcpUpdate: ({ opens, flags, failure }) =>
			Configure.completedUpdate(model, opens, flags, failure),
		ClickedGcpRunEdit: () => Configure.clickedRunEdit(model, env),
		CompletedGcpConfigureScripts: ({ key, result }) => Configure.completedScripts(model, key, result),
		ClickedGcpConfigureScriptRetry: () => Configure.retriedScripts(model, env),
		ClickedGcpScriptExpand: () => Configure.clickedScriptExpand(model),
		ClickedGcpMethod: ({ method }) => Configure.clickedMethod(model, method),
		GotGcpFlavourMessage: ({ message: child }) => Configure.gotFlavour(model, child),
		ClickedGcpMethodContinue: () => Configure.clickedMethodContinue(model, env),
		ClickedGcpManualStep: ({ title, firstTitle }) =>
			Configure.clickedManualStep(model, title, firstTitle),
		ClickedGcpCopyPrompt: ({ prompt }) => Configure.clickedCopyPrompt(model, prompt),
		CompletedGcpPromptCopy: ({ isCopied }) => Configure.completedPromptCopy(model, isCopied),
		ClickedGcpPromptBack: () => Configure.clickedPromptBack(model),
		ClickedGcpConfirmRemoval: () => Configure.clickedConfirmRemoval(model, env),
		CompletedGcpConfirmRemoval: ({ failure }) => Configure.completedConfirmRemoval(model, failure),
		TickedGcpRefresh: () => ({
			model,
			requests: [HubRequest.readStatus("Refresh"), HubRequest.readClock()],
		}),
	})

export const GCP: ProviderModule<Status, GcpCardModel, GcpMessage> = {
	id: "gcp",
	statusRead: GCP_STATUS_READ,
	init: initGcpCard,
	update,
	// The band's reads wait on the status and the clock.
	onEnter: (model, env) =>
		Gcp.steps(model, [(next) => Gcp.enterGcp(next, env), (next) => Gcp.requestBand(next, env)]),
	onClock: Gcp.requestBand,
	onStatus: (model, env, { isCurrent }) =>
		Gcp.requestBand(
			isCurrent && AsyncData.isSuccess(env.status.data) ? Configure.statusArrived(model, env) : model,
			env,
		),
	subscriptions: [
		{
			everyMs: 10_000,
			isActive: (_model, env) =>
				env.isShown && Gcp.connectorsIn(env.status).length > 0 && isSettling(env.status, env.nowMs),
			tick: GcpMessage.TickedGcpRefresh(),
		},
		{
			everyMs: 60_000,
			isActive: (_model, env) =>
				env.isShown && Gcp.connectorsIn(env.status).length > 0 && !isSettling(env.status, env.nowMs),
			tick: GcpMessage.TickedGcpRefresh(),
		},
		// While the cleanup dialog is open.
		{
			everyMs: 10_000,
			isActive: (model) => model.disconnectDialog.isOpen && model.disconnectDialog.kind === "dialog",
			tick: GcpMessage.TickedGcpRefresh(),
		},
		// Until the wizard's run is confirmed.
		{
			everyMs: 10_000,
			isActive: (model, env) => Configure.isAwaitingRun(model, env.status, env.nowMs),
			tick: GcpMessage.TickedGcpRefresh(),
		},
	],
	card: (h, model, timeZone, focusId) => [gcpCard(h, model, timeZone, focusId)],
	headerStatus: (h, model) => gcpHeaderStatus(h, model),
	flow: (model) => gcpFlow(model),
	flowView: (h, model, stage, timeZone) => gcpFlowView(h, model, stage, timeZone),
	cardStatus: (slot) =>
		fold(
			slot,
			(status): CardStatus =>
				status.connectors.length === 0
					? NOT_CONNECTED
					: { label: countLabel(status.connectors.length, "connection"), variant: "ok" },
			unavailableStatus,
		),
	overview: (slot, { nowMs }) =>
		fold(
			slot,
			(status): IntegrationOverview => {
				const connectors = status.connectors
				if (connectors.length === 0) return SET_UP
				const states = Arr.map(connectors, (connector) => gcpConnectionState(connector, nowMs))
				const count = (state: (typeof states)[number]) =>
					Arr.filter(states, (entry) => entry === state).length
				const worst = gcpWorstState(states)
				const lastData = maxMs(
					Arr.map(
						Arr.flatMap(connectors, (connector) => [
							connector.logs_enabled ? connector.last_log_received_at : null,
							connector.metrics_enabled ? connector.last_metrics_received_at : null,
						]),
						isoMs,
					),
				)
				return {
					kind: "connected",
					health: worst === "attention" || worst === "healthy" ? worst : "pending",
					stateLabel: GCP_CONNECTION_LABEL[worst],
					context:
						connectors.length === 1 && connectors[0] !== undefined
							? gcpScopeLabel(connectors[0])
							: countLabel(connectors.length, "connection"),
					stat: Arr.join(
						Arr.filter(
							[
								Arr.some(connectors, (connector) => connector.logs_enabled) ? "Logs" : null,
								Arr.some(connectors, (connector) => connector.metrics_enabled)
									? "Metrics and resources"
									: null,
							],
							(part) => part !== null,
						),
						" · ",
					),
					lastSync: worst === "waiting" ? null : lastSyncOf(lastData, "last data"),
					issue:
						worst === "attention"
							? `${countLabel(count("attention"), "connection")} failing`
							: worst === "setup-pending" || worst === "changes-pending"
								? "Finish setup"
								: null,
				}
			},
			unavailableOverview,
		),
}
