import {
	derivePlanetScaleSetup,
	metricsCollectionFailing,
} from "../../../../components/integrations/planetscale-setup-steps"
import { EMPTY_VALUE, formatNumber, pluralize } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "../../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { skeleton } from "../../../../ui/skeleton"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { docsLink, emptyActions } from "../../../kit/signal-empty-state"
import { pageHeroParts } from "../../../infra/kit/page-parts"
import { pageTime } from "../../kit/page-time"
import { listToolbar, toolbarStat } from "../../../kit/list-toolbar"
import type { DatabaseList, DatabaseStat, PlanetscaleStatus } from "../data"
import {
	formatLag,
	formatStoragePercent,
	lagTone,
	utilizationTone,
} from "../../../../components/infra/planetscale/metrics"
import {
	inventoryIsStale,
	inventoryNotice,
	metricsNotice,
	planetscaleConnectCta,
	revokedNotice,
	setupState,
} from "../notices"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET, neverCollected, sortOf } from "./update"
import { databaseTable, databaseTableLoading } from "./view-table"

// `PlanetScalePage`.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const NO_STATS: ReadonlyArray<DatabaseStat> = []

const loading = (h: H): Html =>
	h.div(
		[h.Class("space-y-4")],
		[listToolbar(h, { trailing: [skeleton(h, "h-4 w-72")] }), databaseTableLoading(h)],
	)

interface Totals {
	readonly connections: number
	readonly lagMax: number
	readonly lagOwner: string | null
	readonly storageMax: number | null
	readonly storageOwner: string | null
}

const NO_TOTALS: Totals = { connections: 0, lagMax: 0, lagOwner: null, storageMax: null, storageOwner: null }

const totalsOf = (stats: ReadonlyArray<DatabaseStat>): Totals =>
	stats.reduce<Totals>(
		(acc, row) => ({
			connections: acc.connections + row.connectionsAvg,
			...(row.replicaLagMaxSeconds > acc.lagMax
				? { lagMax: row.replicaLagMaxSeconds, lagOwner: row.database }
				: { lagMax: acc.lagMax, lagOwner: acc.lagOwner }),
			...(row.storageUsedPercent !== null &&
			(acc.storageMax === null || row.storageUsedPercent > acc.storageMax)
				? { storageMax: row.storageUsedPercent, storageOwner: row.database }
				: { storageMax: acc.storageMax, storageOwner: acc.storageOwner }),
		}),
		NO_TOTALS,
	)

const noDatabases = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "PlanetScaleIcon", { size: 16 })]),
				emptyTitle(h, ["No databases discovered yet"]),
				emptyDescription(h, [
					"Maple refreshes the database and branch list within a few minutes of connecting. If this persists, check that the connection still has the read_databases permission.",
				]),
			]),
			emptyActions(h, [
				linkButton(
					h,
					{
						variant: "outline",
						size: "sm",
						href: hrefOf(AppRoute.SourcesNew({ search: { integration: "planetscale" } })),
					},
					["Check the connection"],
				),
				docsLink(h, "planetscale"),
			]),
		],
		"py-16",
	)

/** The fleet's figures as toolbar readouts; the worst storage and lag name their database. */
const summaryToolbar = (
	h: H,
	options: Readonly<{ databases: number; branchTotal: number; never: boolean; totals: Totals }>,
): Html => {
	const { totals } = options
	// A neutral reading needs no dot.
	const dotOf = (tone: Tone): Tone | undefined => (tone === "neutral" ? undefined : tone)
	const lagHasOwner = totals.lagOwner !== null && totals.lagMax > 0
	return listToolbar(h, {
		trailing: [
			toolbarStat(h, {
				value: String(options.databases),
				label: pluralize(options.databases, "database"),
			}),
			toolbarStat(h, {
				value: String(options.branchTotal),
				label: pluralize(options.branchTotal, "branch", "branches"),
			}),
			...(options.never
				? []
				: [
						toolbarStat(h, {
							value:
								totals.storageMax === null
									? EMPTY_VALUE
									: formatStoragePercent(totals.storageMax),
							label:
								totals.storageOwner === null
									? "worst storage"
									: `worst storage (${totals.storageOwner})`,
							dot:
								totals.storageMax === null
									? undefined
									: dotOf(utilizationTone(totals.storageMax)),
						}),
						toolbarStat(h, {
							value: formatLag(totals.lagMax),
							label: lagHasOwner
								? `worst replica lag (${totals.lagOwner})`
								: "worst replica lag",
							dot: dotOf(lagTone(totals.lagMax)),
						}),
						...(lagHasOwner
							? []
							: [
									toolbarStat(h, {
										value: formatNumber(totals.connections),
										label: "connections",
									}),
								]),
					]),
		],
	})
}

const content = (
	h: H,
	model: Model,
	status: PlanetscaleStatus,
	inventory: DatabaseList,
	clock: Clock,
): Html => {
	// `Result.builder(...).onSuccess(...).orElse(NO_STATS)`: a failed read shows no numbers.
	const statsData = model.stats.data
	const stats =
		AsyncData.isSuccess(statsData) || AsyncData.isRefreshing(statsData) ? statsData.data : NO_STATS
	const never = neverCollected(model)
	const branchTotal = inventory.databases.reduce((sum, db) => sum + db.branches.length, 0)
	const showInventoryNotice =
		status.last_inventory_error !== null || inventoryIsStale(inventory.last_inventory_at, clock.nowMs)
	const totals = totalsOf(stats)
	const statsFailure = Option.toArray(AsyncData.getError(statsData))
	return h.div(
		[h.Class("space-y-6")],
		[
			...(status.revoked_at !== null ? [revokedNotice(h)] : []),
			...(status.revoked_at === null && !never && metricsCollectionFailing(status, clock.nowMs)
				? [metricsNotice(h, status)]
				: []),
			...(showInventoryNotice
				? [
						inventoryNotice(h, {
							lastInventoryAt: inventory.last_inventory_at,
							lastInventoryError: status.last_inventory_error,
							...clock,
						}),
					]
				: []),
			...statsFailure.map((error) =>
				errorState(h, {
					failure: error,
					title: "Couldn't load database stats",
					onRetry: Message.ClickedRetryStats(),
					variant: "row",
				}),
			),
			...(never
				? [
						setupState(
							h,
							derivePlanetScaleSetup(status, clock.nowMs, {
								databases: inventory.databases.length,
								branches: branchTotal,
							}).checks,
						),
					]
				: []),
			summaryToolbar(h, { databases: inventory.databases.length, branchTotal, never, totals }),
			inventory.databases.length === 0
				? noDatabases(h)
				: databaseTable(h, {
						databases: inventory.databases,
						stats,
						sort: sortOf(model),
						isWaiting: AsyncData.isRefreshing(statsData) || AsyncData.isLoading(statsData),
						metricsPaused: never,
						emptyMessage: "No databases in the inventory.",
					}),
		],
	)
}

const failure = (h: H, error: LoadFailure): Html => errorState(h, { failure: error })

const connected = (h: H, model: Model, status: PlanetscaleStatus, clock: Clock): Html =>
	!status.connected
		? planetscaleConnectCta(h)
		: AsyncData.match(model.databases.data, {
				onIdle: () => loading(h),
				onLoading: () => loading(h),
				onFailure: (error) => failure(h, error),
				onStale: ({ error }) => failure(h, error),
				onRefreshing: (inventory) => content(h, model, status, inventory, clock),
				onSuccess: (inventory) => content(h, model, status, inventory, clock),
			})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	const hero = pageHeroParts(h, {
		title: "PlanetScale",
		description:
			"Database health from your PlanetScale organization: connections, CPU, memory, storage, and replication lag for every branch.",
	})
	return dashboardPage(
		h,
		{
			gap: "lg",
			titleContent: hero.title,
			actions: pageTime(h, {
				search: model.search,
				defaultPreset: DEFAULT_PRESET,
				window: model.window,
				picker: model.timePicker,
				toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
				onReset: Message.ClickedResetTimeRange(),
				onReload: Message.ClickedReload(),
				isReloading: model.isReloading,
			}),
		},
		[
			hero.body,
			AsyncData.match(model.status.data, {
				onIdle: () => loading(h),
				onLoading: () => loading(h),
				onFailure: (error) => failure(h, error),
				onStale: ({ data }) => connected(h, model, data, clock),
				onRefreshing: (data) => connected(h, model, data, clock),
				onSuccess: (data) => connected(h, model, data, clock),
			}),
		],
	)
})
