import { Option, Result } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { AppRoute } from "../../../route"
import * as CopyButton from "../../../ui/copy-button"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { monitorIdFromUrl } from "../shared/uptime-commands"
import { formatMs } from "../shared/uptime-derive"
import {
	CheckMonitorNow,
	FetchCheckStats,
	FetchMonitor,
	FetchMonitorSession,
	ReadMonitorClock,
	ToggleMonitorEnabled,
} from "./command"
import { Message } from "./message"
import type { Model, UptimeWindow } from "./model"

type Return = PageReturn<Model, Message>
type MonitorRoute = Extract<AppRoute, { readonly _tag: "AlertsUptimeMonitor" }>

const monitorKey = (context: PageContext, monitorId: string) =>
	requestKey(context.orgId, "uptimeMonitors.retrieve", { monitorId })

const statsKey = (context: PageContext, monitorId: string, window: UptimeWindow) =>
	requestKey(context.orgId, "uptimeMonitors.checkStats", { monitorId, window })

/** Reads the window's checks once the monitor is known to probe; heartbeats record no check spans. */
const requestStats = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const id = model.monitorId
	const isProbed = Option.match(monitorOf(model), {
		onNone: () => false,
		onSome: (monitor) => monitor.kind !== "heartbeat",
	})
	if (id === null || !isProbed) return { model }
	return Option.match(Keyed.requestFor(model.stats, statsKey(context, id, model.window), mode), {
		onNone: () => ({ model }),
		onSome: (stats) => ({
			model: { ...model, stats },
			commands: [FetchCheckStats({ key: stats.key, monitorId: id, window: model.window })],
		}),
	})
}

/** Reads the monitor under `mode`; nothing to read for an id that does not decode. */
const requestMonitor = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const id = model.monitorId
	if (id === null) return { model }
	return Option.match(Keyed.requestFor(model.monitor, monitorKey(context, id), mode), {
		onNone: () => ({ model }),
		onSome: (monitor) => ({
			model: { ...model, monitor },
			commands: [FetchMonitor({ key: monitor.key, monitorId: id })],
		}),
	})
}

export const init = (route: MonitorRoute, context: PageContext): Return => {
	const monitorId = Option.getOrNull(monitorIdFromUrl(route.monitorId))
	const model: Model = {
		rawMonitorId: route.monitorId,
		monitorId,
		nowMs: null,
		monitor: Keyed.idle(),
		destinations: null,
		incidents: null,
		isAdmin: false,
		isToggling: false,
		isChecking: false,
		copies: {},
		window: "24h",
		stats: Keyed.idle(),
		chart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	}
	const read = requestMonitor(model, context, "Load")
	return {
		model: read.model,
		commands: [
			ReadMonitorClock(),
			FoldkitCommand.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
			FetchMonitorSession({ orgId: context.orgId }),
			...(read.commands ?? []),
		],
	}
}

const toast = (type: "success" | "error", title: string, description = ""): PageOutMessage =>
	PageOutMessage.RequestedToast({ type, title, description })

export const monitorOf = (model: Model) => AsyncData.getData(model.monitor.data)

const toggle = (model: Model): Return =>
	Option.match(monitorOf(model), {
		onNone: () => ({ model }),
		onSome: (monitor) =>
			model.isToggling
				? { model }
				: {
						model: { ...model, isToggling: true },
						commands: [
							ToggleMonitorEnabled({ monitorId: monitor.id, enabled: !monitor.enabled }),
						],
					},
	})

const checkNow = (model: Model): Return =>
	Option.match(monitorOf(model), {
		onNone: () => ({ model }),
		onSome: (monitor) =>
			model.isChecking || monitor.config.type !== "http"
				? { model }
				: {
						model: { ...model, isChecking: true },
						commands: [CheckMonitorNow({ config: monitor.config })],
					},
	})

const updateCopy = (model: Model, id: string, message: CopyButton.Message): Return => {
	const step = CopyButton.update(model.copies[id] ?? CopyButton.init(), message)
	return {
		model: { ...model, copies: { ...model.copies, [id]: step.model } },
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (child) =>
			Message.GotCopyMessage({ id, message: child }),
		),
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchMonitor: ({ key, result }) =>
			requestStats({ ...model, monitor: Keyed.accept(model.monitor, key, result) }, context, "Load"),
		ClickedRetry: () => requestMonitor(model, context, "Supersede"),
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		UpdatedIncidents: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, incidents: rows } } : { model },
		CompletedFetchSession: ({ orgId, isAdmin }) =>
			orgId === context.orgId ? { model: { ...model, isAdmin } } : { model },
		ClickedToggle: () => toggle(model),
		CompletedToggle: ({ result }) => {
			const settled = { ...model, isToggling: false }
			return Result.match(result, {
				onSuccess: (monitor): Return => {
					const reread = requestMonitor(settled, context, "Supersede")
					return {
						...reread,
						outMessage: toast("success", monitor.enabled ? "Monitor resumed" : "Monitor paused"),
					}
				},
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: toast("error", "Couldn't update the monitor", failure.message),
				}),
			})
		},
		ClickedCheckNow: () => checkNow(model),
		CompletedCheckNow: ({ result }) => ({
			model: { ...model, isChecking: false },
			outMessage: Result.match(result, {
				onSuccess: (check) =>
					check.ok
						? toast(
								"success",
								"Check passed",
								`${check.status_code ?? "No status"} in ${formatMs(check.duration_ms)}`,
							)
						: toast(
								"error",
								"Check failed",
								check.failed_assertion ?? check.error ?? "The check did not pass.",
							),
				onFailure: (failure) => toast("error", "Couldn't run the check", failure.message),
			}),
		}),
		GotCopyMessage: ({ id, message: child }) => updateCopy(model, id, child),
		PickedWindow: ({ window }) =>
			window === model.window ? { model } : requestStats({ ...model, window }, context, "Load"),
		CompletedFetchStats: ({ key, result }) => ({
			model: { ...model, stats: Keyed.accept(model.stats, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ message: child }) => {
			const next = Chart.update(model.chart, child)
			return {
				model: { ...model, chart: next.model },
				commands: FoldkitCommand.mapMessages(next.commands ?? [], (message) =>
					Message.GotChartMessage({ message }),
				),
			}
		},
	})
