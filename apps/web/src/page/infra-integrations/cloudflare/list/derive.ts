import {
	type CloudflareAccount,
	cloudflareAccounts,
	zoneAccountIds,
} from "../../../../components/infra/cloudflare/accounts"
import {
	CLOUDFLARE_VIEWS,
	type CloudflareView,
	mergeWorkerRows,
	type WorkerListRow,
} from "../../../../components/infra/cloudflare/list-model"
import { AsyncData } from "foldkit"
import type { PlatformResources, QueueRow, Usage, ZoneBucket, ZoneRow } from "../data"
import { ingestPhaseOf } from "../ingest"
import type { Model } from "./model"
import { Array as Arr, String as Str, Option } from "effect"

/** A loaded value, refreshing included; a failure or an empty slot reads as not there yet. */
export const dataOf = <A, E>(slot: AsyncData.AsyncData<A, E>): A | null =>
	AsyncData.isSuccess(slot) || AsyncData.isRefreshing(slot) ? slot.data : null

export const isWaiting = <A, E>(slot: AsyncData.AsyncData<A, E>): boolean => AsyncData.isRefreshing(slot)

export const statusOf = (model: Model) => dataOf(model.status.data)

const usageOf = (model: Model): Usage | null => dataOf(model.usage.data)

export const phaseOf = (model: Model) => ingestPhaseOf(statusOf(model), usageOf(model), model.nowMs)

export const accountsOf = (model: Model): ReadonlyArray<CloudflareAccount> =>
	cloudflareAccounts(statusOf(model)?.accounts ?? [], model.nowMs)

/** Requests per bucket per zone, in bucket order, for the row sparklines. */
export const requestSparks = (
	buckets: ReadonlyArray<ZoneBucket>,
): ReadonlyMap<string, ReadonlyArray<number>> => {
	const byZone = new Map<string, Array<ZoneBucket>>()
	Arr.forEach(buckets, (row) => byZone.set(row.serviceName, [...(byZone.get(row.serviceName) ?? []), row]))
	return new Map(
		Arr.map([...byZone], ([serviceName, series]) => [
			serviceName,
			Arr.map(
				Arr.sort(series, (a: ZoneBucket, b: ZoneBucket) => Str.localeCompare(b.bucket)(a.bucket)),
				(point) => point.requests,
			),
		]),
	)
}

export type ListData = Readonly<{
	zones: ReadonlyArray<ZoneRow> | null
	sparks: ReadonlyMap<string, ReadonlyArray<number>> | undefined
	platform: PlatformResources | null
	workerRows: ReadonlyArray<WorkerListRow> | null
}>

/** `CloudflareData`'s reads: null while loading (a failed read stays loading). */
export const listDataOf = (model: Model): ListData => {
	const timeseries = dataOf(model.timeseries.data)
	const platform = dataOf(model.platform.data)
	const workers = dataOf(model.workers.data)
	return {
		zones: dataOf(model.zones.data),
		sparks: timeseries === null ? undefined : requestSparks(timeseries),
		platform,
		workerRows: workers === null ? null : mergeWorkerRows(workers, platform?.durableObjects ?? []),
	}
}

export const isNoTraffic = (data: ListData): boolean =>
	data.zones?.length === 0 && data.workerRows?.length === 0 && data.platform?.queues.length === 0

export type ListScope = Readonly<{
	accounts: ReadonlyArray<CloudflareAccount>
	multiAccount: boolean
	accountId: string | undefined
	zoneAccount: ReadonlyMap<string, string>
	accountNames: ReadonlyMap<string, string>
	zones: ReadonlyArray<ZoneRow> | null
	workerRows: ReadonlyArray<WorkerListRow> | null
	queues: ReadonlyArray<QueueRow> | null
	counts: Readonly<Record<CloudflareView, number | null>>
	view: CloudflareView
	showAccountColumn: boolean
	scopedAccount: CloudflareAccount | undefined
}>

/** `CloudflareListPage`'s account scoping, counts, and the view fallback. */
export const listScopeOf = (
	model: Model,
	data: ListData,
	accounts: ReadonlyArray<CloudflareAccount> = accountsOf(model),
): ListScope => {
	const multiAccount = accounts.length > 1
	const accountId = multiAccount
		? Option.getOrUndefined(
				Option.map(
					Arr.findFirst(accounts, (account) => account.accountId === model.search.account),
					(account) => account.accountId,
				),
			)
		: undefined
	const zoneAccount = zoneAccountIds(accounts)
	const allQueues = data.platform?.queues ?? null
	const zones =
		accountId === undefined
			? data.zones
			: Option.getOrNull(
					Option.map(Option.fromNullishOr(data.zones), (rows) =>
						Arr.filter(rows, (zone) => zoneAccount.get(zone.serviceName) === accountId),
					),
				)
	const workerRows =
		accountId === undefined
			? data.workerRows
			: Option.getOrNull(
					Option.map(Option.fromNullishOr(data.workerRows), (rows) =>
						Arr.filter(rows, (row) => row.accountId === accountId),
					),
				)
	const queues =
		accountId === undefined
			? allQueues
			: Option.getOrNull(
					Option.map(Option.fromNullishOr(allQueues), (rows) =>
						Arr.filter(rows, (queue) => queue.accountId === accountId),
					),
				)
	const counts = {
		zones: zones?.length ?? null,
		workers: workerRows?.length ?? null,
		queues: queues?.length ?? null,
	}
	const view =
		model.search.view ??
		Option.getOrElse(
			Arr.findFirst(CLOUDFLARE_VIEWS, (v) => (counts[v] ?? 0) > 0),
			(): (typeof CLOUDFLARE_VIEWS)[number] => "zones",
		)
	return {
		accounts,
		multiAccount,
		accountId,
		zoneAccount,
		accountNames: new Map(Arr.map(accounts, (account) => [account.accountId, account.name])),
		zones,
		workerRows,
		queues,
		counts,
		view,
		showAccountColumn: multiAccount && accountId === undefined,
		scopedAccount: Option.getOrUndefined(
			Arr.findFirst(accounts, (account) => account.accountId === accountId),
		),
	}
}

/** Each account's share of the current view: edge requests, invocations, or queue backlog. */
export const accountShares = (
	view: CloudflareView,
	data: ListData,
	zoneAccount: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> => {
	const entries: ReadonlyArray<readonly [string | undefined, number]> =
		view === "zones"
			? Arr.map(data.zones ?? [], (zone) => [zoneAccount.get(zone.serviceName), zone.requests])
			: view === "queues"
				? Arr.map(data.platform?.queues ?? [], (queue) => [queue.accountId, queue.backlogMessages])
				: Arr.map(data.workerRows ?? [], (row) => [row.accountId, row.requests])
	const totals = Arr.reduce(entries, new Map<string, number>(), (acc, [id, n]) => {
		if (id !== undefined) acc.set(id, (acc.get(id) ?? 0) + n)
		return acc
	})
	const sum = Arr.reduce([...totals.values()], 0, (a, b) => a + b)
	return new Map(Arr.map([...totals], ([id, n]) => [id, sum > 0 ? n / sum : 0]))
}

export const accountCounts = (
	accounts: ReadonlyArray<CloudflareAccount>,
	data: ListData,
	zoneAccount: ReadonlyMap<string, string>,
): ReadonlyMap<string, { zones: number; workers: number }> =>
	new Map(
		Arr.map(accounts, (account) => [
			account.accountId,
			{
				zones: Arr.filter(
					data.zones ?? [],
					(zone) => zoneAccount.get(zone.serviceName) === account.accountId,
				).length,
				workers: Arr.filter(data.workerRows ?? [], (row) => row.accountId === account.accountId)
					.length,
			},
		]),
	)
