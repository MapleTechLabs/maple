import { OrgId } from "@maple/domain"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { ChartRuntime, LoadChartRuntime } from "../../charts/chart-runtime"
import { ThemeColors } from "../../charts/theme-colors"
import type { PageContext } from "../../page/contract"
import * as HostsList from "../../page/infra/hosts/list/message"
import { SortState, nextSort } from "../../page/kit/table-sort"
import * as RailwayList from "../../page/infra-integrations/railway/list/message"
import { Model as RailwayModel } from "../../page/infra-integrations/railway/list/model"
import * as RailwayUpdate from "../../page/infra-integrations/railway/list/update"
import * as VercelList from "../../page/infra-integrations/vercel/list/model"
import * as VercelListUpdate from "../../page/infra-integrations/vercel/list/update"
import * as VercelProject from "../../page/infra-integrations/vercel/project/model"
import * as VercelProjectUpdate from "../../page/infra-integrations/vercel/project/update"
import type { Resources } from "../../platform/resources"
import {
	VERCEL_AI_GATEWAY,
	VERCEL_API_AI_GATEWAY,
	VERCEL_API_DEPLOYMENTS,
	VERCEL_API_DETAIL,
	VERCEL_BUCKETS,
	VERCEL_PROJECTS,
	VERCEL_STATUS,
} from "../vercel-infra-fixtures"

// `/lab/infra`: the infra overview, hosts list, Railway list and the Vercel pages
// over fixture rows. Each list's own Model hosts its table's sort, tooltips and charts.

const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_infra"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

export const Model = Schema.Struct({
	/** `const NOW = Date.now()` at module load: the fixture is built from it. */
	nowMs: Schema.Number,
	timeZone: Schema.String,
	hostQuery: Schema.String,
	hostScope: Schema.optional(HostsList.HostScope),
	/** `HostTable`'s own `useTableSort`: CPU, descending. */
	hostSort: SortState,
	railway: RailwayModel,
	/** The Vercel list's projects and AI Gateway views and one project's page, their reads answered. */
	vercelProjects: VercelList.Model,
	vercelAiGateway: VercelList.Model,
	vercelProject: VercelProject.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ChangedHostQuery: { value: Schema.String },
	ChangedHostScope: { scope: Schema.optional(HostsList.HostScope) },
	ClickedHostSort: { key: HostsList.HostSortKey },
	GotRailwayMessage: { message: RailwayList.Message },
	GotVercelListMessage: { view: Schema.Literals(["projects", "aiGateway"]), message: VercelList.Message },
	GotVercelProjectMessage: { message: VercelProject.Message },
	SettledChartRuntime: { runtime: ChartRuntime },
	ResolvedThemeColors: { colors: ThemeColors },
})
export type Message = typeof Message.Type

export const Flags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
})

type Return = Update.Return<Model, Message, Resources>

const DAY_MS = 24 * 60 * 60 * 1000

const answered = <A>(data: A) => ({ key: "lab", data: AsyncData.Success({ data }) })

/** The fixtures' last day, so the request series fill the window's buckets. */
const vercelWindow = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - DAY_MS),
	endTime: formatWarehouseDateTime(nowMs),
})

const vercelList = (flags: Flags, view: "projects" | "aiGateway"): VercelList.Model => ({
	...VercelListUpdate.init({ search: view === "projects" ? {} : { view } }, LAB_CONTEXT).model,
	window: vercelWindow(flags.nowMs),
	nowMs: flags.nowMs,
	status: answered(VERCEL_STATUS),
	projects: answered(VERCEL_PROJECTS),
	buckets: answered(VERCEL_BUCKETS),
	aiGateway: answered(VERCEL_AI_GATEWAY),
})

const vercelProject = (flags: Flags): VercelProject.Model => ({
	...VercelProjectUpdate.init({ projectId: "prj_api", search: {} }, LAB_CONTEXT).model,
	window: vercelWindow(flags.nowMs),
	nowMs: flags.nowMs,
	status: answered(VERCEL_STATUS),
	projects: answered(VERCEL_PROJECTS),
	buckets: answered(VERCEL_BUCKETS),
	detail: answered(VERCEL_API_DETAIL),
	deployments: answered(VERCEL_API_DEPLOYMENTS),
	aiGateway: answered(VERCEL_API_AI_GATEWAY),
})

/** The lists' reads are not sent: their Models carry the fixtures and the tables' local state. */
export const init = (flags: Flags): Return => ({
	model: {
		...flags,
		hostQuery: "",
		hostSort: { key: "cpuPct", dir: "desc" },
		railway: RailwayUpdate.init({ search: {} }, LAB_CONTEXT).model,
		vercelProjects: vercelList(flags, "projects"),
		vercelAiGateway: vercelList(flags, "aiGateway"),
		vercelProject: vercelProject(flags),
	},
	commands: [
		Command.mapMessage(LoadChartRuntime(), (message) =>
			Message.SettledChartRuntime({
				runtime:
					message._tag === "CompletedLoadChartRuntime"
						? { _tag: "Ready" }
						: { _tag: "Failed", reason: message.reason },
			}),
		),
	],
})

/** The chart runtime and theme reach every Vercel frame at once. */
const vercelPatch = (model: Model, patch: Partial<Pick<VercelList.Model, "chartRuntime" | "themeColors">>): Model => ({
	...model,
	vercelProjects: { ...model.vercelProjects, ...patch },
	vercelAiGateway: { ...model.vercelAiGateway, ...patch },
	vercelProject: { ...model.vercelProject, ...patch },
})

/** The Vercel pages' table sort and charts; their links, search and reads stay inert here. */
const LOCAL_VERCEL_MESSAGES: ReadonlySet<string> = new Set(["ClickedSort", "GotChartMessage"])

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ChangedHostQuery: ({ value }) => ({ model: { ...model, hostQuery: value } }),
		ChangedHostScope: ({ scope }) => ({ model: { ...model, hostScope: scope } }),
		ClickedHostSort: ({ key }) => ({
			model: { ...model, hostSort: nextSort(model.hostSort, key, { stringKeys: ["hostName"] }) },
		}),
		GotVercelListMessage: ({ view, message: inner }) => {
			if (!LOCAL_VERCEL_MESSAGES.has(inner._tag)) return { model }
			const field = view === "projects" ? "vercelProjects" : "vercelAiGateway"
			const next = VercelListUpdate.update(model[field], inner, LAB_CONTEXT)
			return {
				model: { ...model, [field]: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotVercelListMessage({ view, message: child }),
				),
			}
		},
		GotVercelProjectMessage: ({ message: inner }) => {
			if (!LOCAL_VERCEL_MESSAGES.has(inner._tag)) return { model }
			const next = VercelProjectUpdate.update(model.vercelProject, inner, LAB_CONTEXT)
			return {
				model: { ...model, vercelProject: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotVercelProjectMessage({ message: child }),
				),
			}
		},
		SettledChartRuntime: ({ runtime }) => ({ model: vercelPatch(model, { chartRuntime: runtime }) }),
		ResolvedThemeColors: ({ colors }) => ({ model: vercelPatch(model, { themeColors: colors }) }),
		// Only the table's sort and tooltips; the Railway search box here is inert.
		GotRailwayMessage: ({ message: inner }) => {
			if (inner._tag !== "ClickedSort" && inner._tag !== "GotRowTooltipMessage") return { model }
			const next = RailwayUpdate.update(model.railway, inner, LAB_CONTEXT)
			return {
				model: { ...model, railway: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotRailwayMessage({ message: child }),
				),
			}
		},
	})
