import { Effect } from "effect"
import { Command, type Update } from "foldkit"
import { load } from "foldkit/navigation"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import { CompleteReloadSpin } from "../../page/infra-integrations/gcp/list/command"
import * as GcpList from "../../page/infra-integrations/gcp/list/model"
import { stepProjectMenu } from "../../page/infra-integrations/gcp/list/project-menu"
import { stepTimePicker } from "../../page/infra-integrations/kit/page-time"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import * as Menu from "../../ui/menu"
import { type ListState, Message, type Model } from "./model"

type Return = Update.Return<Model, Message, Resources>

/** "Manage connections" is a link out of the lab to `/integrations`. */
export const LoadIntegrationsPage = Command.define("LoadGcpIntegrationsPage", {
	messages: [Message.CompletedLoadIntegrationsPage],
	execute: load(hrefOf(AppRoute.SourcesNew({ search: { integration: "gcp" } }))).pipe(
		Effect.as(Message.CompletedLoadIntegrationsPage()),
	),
})

export const init = (): Return => ({
	model: {
		state: { view: "services" },
		projectMenu: Menu.init("gcp-project-menu"),
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		timePicker: TimeRangePicker.init("gcp-time-range"),
		refreshVersion: 0,
		isReloading: false,
	},
	commands: [
		Command.mapMessage(LoadChartRuntime(), (message) =>
			Message.GotListMessage({
				message:
					message._tag === "CompletedLoadChartRuntime"
						? GcpList.Message.CompletedLoadChartRuntime()
						: GcpList.Message.FailedLoadChartRuntime({ reason: message.reason }),
			}),
		),
	],
})

const patch = (model: Model, next: Partial<ListState>): Return => ({
	model: { ...model, state: { ...model.state, ...next } },
})

/** `GcpListPage`'s `onStateChange` and the page's own Mounts, minus every read the route sends. */
const stepList = (model: Model, message: GcpList.Message): Return => {
	switch (message._tag) {
		case "CompletedLoadChartRuntime":
			return { model: { ...model, chartRuntime: { _tag: "Ready" } } }
		case "FailedLoadChartRuntime":
			return { model: { ...model, chartRuntime: { _tag: "Failed", reason: message.reason } } }
		case "ResolvedThemeColors":
			return { model: { ...model, themeColors: message.colors } }
		case "ClickedView":
			return patch(model, { view: message.view, scope: undefined, q: undefined })
		case "ClickedScope":
			return patch(model, { scope: message.scope })
		case "ChangedSearch":
			return patch(model, { q: message.value === "" ? undefined : message.value })
		case "ClickedClearSearch":
			return patch(model, { q: undefined })
		case "ClickedClearRegion":
			return patch(model, { region: undefined, scope: undefined })
		case "SelectedProject":
			return patch(model, { project: message.project, scope: undefined })
		// Reload only spins: the fixtures never reload. A picked range has no URL to go to.
		case "ClickedReload": {
			const refreshVersion = model.refreshVersion + 1
			return {
				model: { ...model, refreshVersion, isReloading: true },
				commands: [
					Command.mapMessage(CompleteReloadSpin({ version: refreshVersion }), (inner) =>
						Message.GotListMessage({ message: inner }),
					),
				],
			}
		}
		case "CompletedReloadSpin":
			return message.version === model.refreshVersion
				? { model: { ...model, isReloading: false } }
				: { model }
		case "GotTimePickerMessage": {
			const step = stepTimePicker(
				model.timePicker,
				message.message,
				(picker) =>
					Message.GotListMessage({
						message: GcpList.Message.GotTimePickerMessage({ message: picker }),
					}),
				() => "",
			)
			return { model: { ...model, timePicker: step.timePicker }, commands: step.commands }
		}
		case "GotProjectMenuMessage": {
			const step = stepProjectMenu(model.projectMenu, message.message)
			const next = { ...model, projectMenu: step.menu }
			const commands = Command.mapMessages(step.commands, (inner) =>
				Message.GotListMessage({ message: inner }),
			)
			const pick = step.pick
			if (pick === null) return { model: next, commands }
			if (pick._tag === "ManageConnections") {
				return { model: next, commands: [...commands, LoadIntegrationsPage()] }
			}
			const picked = patch(next, { project: pick.project, scope: undefined })
			return { model: picked.model, commands }
		}
		default:
			return { model }
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedLabView: ({ view }) => ({ model: { ...model, state: { view } } }),
		CompletedLoadIntegrationsPage: () => ({ model }),
		GotListMessage: ({ message: inner }) => stepList(model, inner),
	})
