import { mergeWorkerRows, type WorkerListRow } from "../../../../components/infra/cloudflare/list-model"
import { deployMarkers } from "../../../../components/infra/cloudflare/worker-signals"
import { toIsoBucket } from "@maple/web-data/warehouse/timeseries-utils"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import type { ChartEventMarker } from "../../../../charts/event-marker-spec"
import type { Release } from "../data"
import { dataOf } from "../list/derive"
import type { Model } from "./model"

export type Traced = Readonly<{ service: string; spans: number; errors: number }>

export type PageData = Readonly<{
	row: WorkerListRow | null
	accountName: string | null
	traced: Traced | null
	markers: ReadonlyArray<ChartEventMarker>
	currentVersion: string | null
}>

/** `WorkerDetailPage`'s reads, combined as the route does. */
export const pageOf = (model: Model): PageData => {
	const workers = dataOf(model.workers.data)
	const durableObjects = dataOf(model.platform.data)?.durableObjects ?? []
	const row =
		workers === null
			? null
			: (mergeWorkerRows(workers, durableObjects).find(
					(worker) =>
						worker.scriptName === model.scriptName &&
						(model.search.account === undefined || worker.accountId === model.search.account),
				) ?? null)
	// Releases carry no account, so for a name shared across accounts they would mix both Workers.
	const loaded = dataOf(model.releases.data)
	const releases: ReadonlyArray<Release> | null =
		loaded === null || row?.nameInOtherAccounts === true
			? null
			: loaded.filter((release) => release.serviceName === model.scriptName)
	const status = dataOf(model.status.data)
	const accounts = status?.accounts ?? []
	const accountId = row?.accountId ?? model.search.account
	const accountName =
		status === null
			? null
			: accounts.length > 1
				? (accounts.find((account) => account.accountId === accountId)?.accountName ?? null)
				: (status.accountName ?? null)
	const traced =
		releases === null || releases.length === 0
			? null
			: {
					service: model.scriptName,
					spans: releases.reduce((acc, release) => acc + release.spanCount, 0),
					errors: releases.reduce((acc, release) => acc + release.errorCount, 0),
				}
	const window = model.window
	const markers =
		window === null
			? []
			: deployMarkers(
					releases ?? [],
					toIsoBucket(window.startTime),
					chartBucketSeconds(window.startTime, window.endTime),
				)
	const currentVersion =
		releases === null || releases.length === 0
			? null
			: (releases.toSorted((a, b) => b.firstSeen.localeCompare(a.firstSeen))[0]?.commitSha ?? null)
	return { row, accountName, traced, markers, currentVersion }
}
