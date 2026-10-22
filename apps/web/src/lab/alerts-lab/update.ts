import { OrgId } from "@maple/domain"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { Update } from "foldkit"
import * as Chart from "../../charts/chart"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import * as AlertsHub from "../../page/alerts/hub/update"
import type { PageContext } from "../../page/contract"
import type { Resources } from "../../platform/resources"
import { foldLabShell, initLabShell, type LabShellFlags } from "../app-shell"
import { Message, type Model } from "./model"

export type Return = Update.Return<Model, Message, Resources>

export const AlertsLabFlags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })
export type AlertsLabFlags = typeof AlertsLabFlags.Type

/** The boot clock and the browser's zone (`Intl.DateTimeFormat().resolvedOptions()`). */
export const alertsLabFlags: Effect.Effect<AlertsLabFlags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
})

/** The hub views run against a hub Model; its org is the fixture's, its admin rights on. */
const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_alerts"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

export const init = (flags: AlertsLabFlags & LabShellFlags): Return => {
	const shell = initLabShell(flags)
	const hub = AlertsHub.init({ _tag: "Alerts", search: {} }, LAB_CONTEXT).model
	return {
		model: {
			nowMs: flags.nowMs,
			timeZone: flags.timeZone,
			hub: { ...hub, isAdmin: true, nowMs: flags.nowMs },
			status: null,
			chart: Chart.init(),
			chartRuntime: { _tag: "Loading" },
			themeColors: null,
			shell: shell.model,
		},
		commands: [
			...(shell.commands ?? []).map(
				Command.mapMessage((message) => Message.GotShellMessage({ message })),
			),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

const foldShell = foldLabShell<Model, Message>((message) => Message.GotShellMessage({ message }))

/** The hub's local UI (menus, the rules search, broken logos); its writes stay no-ops. */
const hubStep = (model: Model, message: Message & { _tag: "GotHubMessage" }): Return => {
	const inner = message.message
	if (inner._tag === "ClickedStatusFilter")
		return { model: { ...model, status: model.status === inner.bucket ? null : inner.bucket } }
	if (inner._tag === "ClickedClearRuleFilters") return { model: { ...model, status: null } }
	const isLocal =
		inner._tag === "ChangedRulesQuery" ||
		inner._tag === "ClickedShowAllRules" ||
		inner._tag === "FailedLoadProviderLogo" ||
		(inner._tag === "GotRowMenuMessage" && inner.message._tag !== "ClickedItem")
	if (!isLocal) return { model }
	const next = AlertsHub.update(model.hub, inner, LAB_CONTEXT)
	return {
		model: { ...model, hub: next.model },
		commands: Command.mapMessages(next.commands ?? [], (child) =>
			Message.GotHubMessage({ message: child }),
		),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: (got) => hubStep(model, got),
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotChartMessage({ message: child }),
				),
			}
		},
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		GotShellMessage: ({ message: inner }) => foldShell(model, inner),
	})
