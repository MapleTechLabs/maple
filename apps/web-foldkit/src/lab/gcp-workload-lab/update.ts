import { type LabWorkload, PAGES, RANGE, WORKLOADS } from "../gcp-workload-fixture"
import { Effect } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import * as Chart from "../../charts/chart"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import { stepTimePicker } from "../../page/infra-integrations/kit/page-time"
import { CompleteReloadSpin } from "../../page/infra-integrations/gcp/workload/command"
import * as Workload from "../../page/infra-integrations/gcp/workload/model"
import { initialModel } from "../../page/infra-integrations/gcp/workload/update"
import type { Resources } from "../../platform/resources"
import { type GcpWorkloadLabFlags, type LabPage, Message, type Model } from "./model"

type Return = Update.Return<Model, Message, Resources>
type Carry = Pick<Workload.Model, "chartRuntime" | "themeColors">

/** The browser's zone, which the trace-gap callout formats its times in. */
export const gcpWorkloadLabFlags: Effect.Effect<GcpWorkloadLabFlags> = Effect.sync(() => ({
	timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}))

export const workloadOf = (page: LabPage): LabWorkload => WORKLOADS[page]

/** The page's Model with the fixture in its slots and the window fixed, so nothing is fetched. */
export const workloadModel = (page: LabPage, carry: Carry): Workload.Model => {
	const workload = workloadOf(page)
	return {
		...initialModel(workload.service, workload.keys[0] ?? "", {}),
		window: { startTime: RANGE.startTime, endTime: RANGE.endTime },
		timeseries: { key: null, data: AsyncData.Success({ data: workload.points }) },
		topQueries: { key: null, data: AsyncData.Success({ data: [] }) },
		...carry,
	}
}

export const init = (flags: GcpWorkloadLabFlags): Return => ({
	model: {
		page: "run",
		timeZone: flags.timeZone,
		workload: workloadModel("run", { chartRuntime: { _tag: "Loading" }, themeColors: null }),
	},
	commands: [
		Command.mapMessage(LoadChartRuntime(), (message) =>
			Message.GotWorkloadMessage({
				message:
					message._tag === "CompletedLoadChartRuntime"
						? Workload.Message.CompletedLoadChartRuntime()
						: Workload.Message.FailedLoadChartRuntime({ reason: message.reason }),
			}),
		),
	],
})

const wrap = (
	commands: ReadonlyArray<Command.Command<Workload.Message, never, Resources>> | undefined,
): ReadonlyArray<Command.Command<Message, never, Resources>> =>
	Command.mapMessages(commands ?? [], (message) => Message.GotWorkloadMessage({ message }))

/** The page's own Messages, minus every read and navigation: the lab's window stays put. */
const stepWorkload = (model: Model, message: Workload.Message): Return => {
	const workload = model.workload
	const set = (
		next: Workload.Model,
		commands?: ReadonlyArray<Command.Command<Message, never, Resources>>,
	) => ({
		model: { ...model, workload: next },
		commands: commands ?? [],
	})
	switch (message._tag) {
		case "CompletedLoadChartRuntime":
			return set({ ...workload, chartRuntime: { _tag: "Ready" } })
		case "FailedLoadChartRuntime":
			return set({ ...workload, chartRuntime: { _tag: "Failed", reason: message.reason } })
		case "ResolvedThemeColors":
			return set({ ...workload, themeColors: message.colors })
		case "ClickedShowAllQueries":
			return set({ ...workload, showAllQueries: !workload.showAllQueries })
		case "GotChartMessage": {
			const { chartId } = message
			const next = Chart.update(workload.charts[chartId] ?? Chart.init(), message.message)
			const commands = Command.mapMessages(next.commands ?? [], (chart) =>
				Message.GotWorkloadMessage({
					message: Workload.Message.GotChartMessage({ chartId, message: chart }),
				}),
			)
			return set({ ...workload, charts: { ...workload.charts, [chartId]: next.model } }, commands)
		}
		// The picker opens and closes; the window stays.
		case "GotTimePickerMessage": {
			const step = stepTimePicker(
				workload.timePicker,
				message.message,
				(picker) => Workload.Message.GotTimePickerMessage({ message: picker }),
				() => "",
			)
			return set({ ...workload, timePicker: step.timePicker }, wrap(step.commands))
		}
		case "ClickedReload": {
			const version = workload.refreshVersion + 1
			return set(
				{ ...workload, refreshVersion: version, isReloading: true },
				wrap([CompleteReloadSpin({ version })]),
			)
		}
		case "CompletedReloadSpin":
			return message.version === workload.refreshVersion
				? set({ ...workload, isReloading: false })
				: { model }
		default:
			return { model }
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		// `key={page}`: the other page mounts fresh; the loaded chart runtime and theme carry over.
		ClickedLabPage: ({ page }) => {
			const next = PAGES.find((candidate) => candidate === page)
			if (next === undefined || next === model.page) return { model }
			const { chartRuntime, themeColors } = model.workload
			return {
				model: { ...model, page: next, workload: workloadModel(next, { chartRuntime, themeColors }) },
			}
		},
		GotWorkloadMessage: ({ message: inner }) => stepWorkload(model, inner),
	})
