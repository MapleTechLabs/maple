import { Effect, Schema } from "effect"
import type { V2PlanetScaleDatabase } from "@maple/domain/http/v2"
import type { DatabaseStat } from "../../page/infra-integrations/planetscale/data"
import { Message, SortKey } from "../../page/infra-integrations/planetscale/list/model"
import { databaseTable } from "../../page/infra-integrations/planetscale/list/view-table"
import { nextSort, sortStateOf } from "../../page/kit/table-sort"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { defineShellLab } from "../shell-lab"

// `/lab/planetscale`: the PlanetScale databases table over fixtures, a Postgres and a MySQL engine.

const Model = Schema.Struct({ sort: sortStateOf(SortKey) })
type Model = typeof Model.Type

const INITIAL: Model = { sort: { key: "connectionsAvg", dir: "desc" } }

const database = (
	name: string,
	kind: string,
	region: string,
	state: string | null = "ready",
): V2PlanetScaleDatabase => ({
	id: `database/${name}`,
	object: "planetscale_integration.database",
	name,
	kind,
	state,
	region,
	plan: "scaler_pro",
	branches: [{ id: `branch/${name}-main`, name: "main", production: true, ready: true }],
})

const DATABASES: ReadonlyArray<V2PlanetScaleDatabase> = [
	database("maple", "postgresql", "us-east"),
	database("maple-eu", "postgresql", "eu-central"),
	database("billing", "mysql", "us-west", "sleeping"),
]

const stat = (
	name: string,
	connectionsAvg: number,
	cpu: number,
	mem: number,
	storage: number,
	lag: number,
): DatabaseStat => ({
	database: name,
	connectionsAvg,
	connectionsMax: connectionsAvg,
	cpuMaxPercent: cpu,
	memMaxPercent: mem,
	replicaLagMaxSeconds: lag,
	storageUsedPercent: storage,
})

const STATS: ReadonlyArray<DatabaseStat> = [
	stat("maple", 125.366, 35, 94, 83, 5.28),
	stat("maple-eu", 41.166, 45, 91, 60, 7.63),
	stat("billing", 12, 8, 40, 22, 0.4),
]

export const lab = defineShellLab("PlanetScale", {
	Model,
	Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init: () => ({ model: INITIAL }),
	update: (model: Model, message: Message) =>
		message._tag === "ClickedSort" ? { model: { sort: nextSort(model.sort, message.key) } } : { model },
	view: (model, h) =>
		dashboardPage(h, { title: "PlanetScale" }, [
			databaseTable(h, {
				databases: DATABASES,
				stats: STATS,
				sort: model.sort,
				isWaiting: false,
				metricsPaused: false,
				emptyMessage: "No databases",
			}),
		]),
	currentPath: "/lab/planetscale",
	breadcrumbs: [{ label: "Infrastructure" }, { label: "PlanetScale" }],
})
