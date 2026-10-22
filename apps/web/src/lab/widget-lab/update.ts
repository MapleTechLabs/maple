import { Clock, Effect, Option } from "effect"
import { Command, Update } from "foldkit"
import * as Chart from "../../charts/chart"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import type { Resources } from "../../platform/resources"
import * as CopyButton from "../../ui/copy-button"
import * as Menu from "../../ui/menu"
import * as Popover from "../../ui/popover"
import * as ToggleGroup from "../../ui/toggle-group"
import { foldLabShell, initLabShell, type LabShellFlags } from "../app-shell"
import { foldLabToasts, initLabToasts } from "../toasts"
import { Message, type Model } from "./model"

type Return = Update.Return<Model, Message, Resources>

export type WidgetLabFlags = LabShellFlags & Readonly<{ timeZone: string }>

const ReadClock = Command.define("ReadWidgetLabClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const init = (flags: WidgetLabFlags): Return => {
	const shell = initLabShell(flags)
	return {
		model: {
			shell: shell.model,
			toasts: initLabToasts(),
			mode: { ...ToggleGroup.init({ label: "", values: ["view"] }) },
			timeZone: flags.timeZone,
			nowMs: null,
			themeColors: null,
			chartRuntime: { _tag: "Loading" },
			charts: {},
			copies: {},
			details: {},
			menuId: null,
			menu: Menu.init("widget-lab-menu"),
			tableSorts: {},
			orgId: Option.getOrNull(flags.maybeOrgId),
		},
		commands: [
			...(shell.commands ?? []).map(
				Command.mapMessage((message) => Message.GotShellMessage({ message })),
			),
			ReadClock(),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

const foldShell = foldLabShell<Model, Message>((message) => Message.GotShellMessage({ message }))
const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

export const menuIdOf = (slot: string) => `widget-lab-menu-${slot}`
export const detailsIdOf = (slot: string) => `widget-lab-details-${slot}`

/** `useSortState` with `resettable`, as the dashboard's tables sort. */
const nextSort = (model: Model, slot: string, field: string, isText: boolean) => {
	const current = model.tableSorts[slot] ?? { key: null, dir: "desc" as const }
	return current.key === field
		? current.dir === "asc"
			? { key: null, dir: current.dir }
			: { key: field, dir: "asc" as const }
		: { key: field, dir: isText ? ("asc" as const) : ("desc" as const) }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotShellMessage: ({ message: inner }) => foldShell(model, inner),
		GotToastMessage: ({ message: inner }) => foldToasts(model, inner),
		GotModeMessage: ({ message: inner }) => {
			const next = ToggleGroup.update(model.mode, inner)
			// A single-select group cannot be emptied (`if (next === "view" || next === "edit")`).
			const values = next.model.values.length === 0 ? model.mode.values : next.model.values
			return {
				model: { ...model, mode: { ...next.model, values } },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotModeMessage({ message: m }),
				),
			}
		},
		CompletedReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		GotChartMessage: ({ slot, message: inner }) => {
			const next = Chart.update(model.charts[slot] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [slot]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotChartMessage({ slot, message: m }),
				),
			}
		},
		GotCopyMessage: ({ slot, message: inner }) => {
			const next = CopyButton.update(model.copies[slot] ?? CopyButton.init(), inner)
			return {
				model: { ...model, copies: { ...model.copies, [slot]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotCopyMessage({ slot, message: m }),
				),
			}
		},
		GotDetailsMessage: ({ slot, message: inner }) => {
			const next = Popover.update(model.details[slot] ?? Popover.init(detailsIdOf(slot)), inner)
			return {
				model: { ...model, details: { ...model.details, [slot]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotDetailsMessage({ slot, message: m }),
				),
			}
		},
		GotMenuMessage: ({ slot, message: inner }) => {
			const current = model.menuId === slot ? model.menu : Menu.init(menuIdOf(slot))
			const next = Menu.update(current, inner)
			return {
				model: { ...model, menuId: slot, menu: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotMenuMessage({ slot, message: m }),
				),
			}
		},
		ClickedSortColumn: ({ slot, field, isText }) => ({
			model: {
				...model,
				tableSorts: { ...model.tableSorts, [slot]: nextSort(model, slot, field, isText) },
			},
		}),
		ClickedWidgetAction: () => ({ model }),
		UpdatedDashboards: () => ({ model }),
	})

export const isEditMode = (model: Model): boolean => model.mode.values.includes("edit")
