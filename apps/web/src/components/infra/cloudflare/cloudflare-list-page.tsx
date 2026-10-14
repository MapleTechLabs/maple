// The /infra/cloudflare list as one presentational page: header, account strip, and the view.
// The route fetches and owns the URL; the lab renders the same component from fixtures.

import { useMemo, type ReactNode } from "react"

import type { CloudflareQueueRow, CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import { HeroChip } from "@/components/common/page-hero"
import { FLEET_BAND_BOXED } from "../primitives/fleet-band"
import { zoneAccountIds, type CloudflareAccount } from "./accounts"
import {
	CloudflareAccountHealthLine,
	CloudflareAccountMenu,
	CloudflareAccountsStrip,
} from "./cloudflare-accounts-ui"
import {
	CloudflareListHeader,
	CloudflareQueuesView,
	CloudflareWorkersView,
	CloudflareZonesView,
} from "./cloudflare-list-views"
import { CloudflareBandLoading } from "./cloudflare-summary-bands"
import { CloudflareZoneTableLoading } from "./cloudflare-zone-table"
import {
	WORKER_SCOPES,
	ZONE_SCOPES,
	CLOUDFLARE_VIEWS,
	type CloudflareView,
	type WorkerListRow,
	type WorkerScope,
	type ZoneScope,
} from "./list-model"

export interface CloudflareListState {
	view?: CloudflareView
	q?: string
	scope?: ZoneScope | WorkerScope
	previews?: boolean
	/** One account of a multi-account grant; absent means all of them. */
	account?: string
}

export function CloudflareListPage({
	accounts,
	singleAccountName,
	zones: allZones,
	sparks,
	workerRows: allWorkerRows,
	queues: allQueues,
	waiting,
	banner,
	state,
	onStateChange,
}: {
	accounts: ReadonlyArray<CloudflareAccount>
	/** Shown as a plain chip when the grant covers one account. */
	singleAccountName: string | null
	/** Null while loading. */
	zones: ReadonlyArray<CloudflareZoneRow> | null
	sparks?: ReadonlyMap<string, ReadonlyArray<number>>
	workerRows: ReadonlyArray<WorkerListRow> | null
	queues: ReadonlyArray<CloudflareQueueRow> | null
	waiting?: { zones?: boolean; workers?: boolean; queues?: boolean }
	/** The ingest banner, when the connection is still filling up. */
	banner?: ReactNode
	state: CloudflareListState
	onStateChange: (patch: Partial<CloudflareListState>) => void
}) {
	const multiAccount = accounts.length > 1
	const accountId = multiAccount
		? accounts.find((a) => a.accountId === state.account)?.accountId
		: undefined
	const zoneAccount = useMemo(() => zoneAccountIds(accounts), [accounts])
	const accountNames = useMemo(() => new Map(accounts.map((a) => [a.accountId, a.name])), [accounts])

	const zones =
		accountId === undefined
			? allZones
			: (allZones?.filter((z) => zoneAccount.get(z.serviceName) === accountId) ?? null)
	const workerRows =
		accountId === undefined
			? allWorkerRows
			: (allWorkerRows?.filter((w) => w.accountId === accountId) ?? null)
	const queues =
		accountId === undefined ? allQueues : (allQueues?.filter((q) => q.accountId === accountId) ?? null)

	const counts = {
		zones: zones?.length ?? null,
		workers: workerRows?.length ?? null,
		queues: queues?.length ?? null,
	}
	// A view with nothing in it falls back to the first view that has something, zones first.
	const view: CloudflareView = state.view ?? CLOUDFLARE_VIEWS.find((v) => (counts[v] ?? 0) > 0) ?? "zones"
	const showAccountColumn = multiAccount && accountId === undefined
	const scopedAccount = accounts.find((a) => a.accountId === accountId)
	const setAccount = (next: string | undefined) => onStateChange({ account: next, scope: undefined })

	return (
		<div className="space-y-6">
			<CloudflareListHeader
				view={view}
				counts={counts}
				account={
					multiAccount ? (
						<CloudflareAccountMenu accounts={accounts} value={accountId} onChange={setAccount} />
					) : singleAccountName ? (
						<HeroChip>account {singleAccountName}</HeroChip>
					) : null
				}
				onViewChange={(next) => onStateChange({ view: next, scope: undefined, q: undefined })}
			/>
			{banner}
			{showAccountColumn ? (
				<CloudflareAccountsStrip
					accounts={accounts}
					share={accountShares(
						view,
						allZones ?? [],
						allWorkerRows ?? [],
						allQueues ?? [],
						zoneAccount,
					)}
					counts={accountCounts(accounts, allZones ?? [], allWorkerRows ?? [], zoneAccount)}
					onSelect={setAccount}
				/>
			) : scopedAccount === undefined ? null : (
				<CloudflareAccountHealthLine account={scopedAccount} />
			)}
			{view === "zones" ? (
				zones === null ? (
					<div className="space-y-4">
						<CloudflareBandLoading className={FLEET_BAND_BOXED} />
						<CloudflareZoneTableLoading />
					</div>
				) : (
					<CloudflareZonesView
						zones={zones}
						sparks={sparks}
						accounts={
							showAccountColumn
								? new Map(
										[...zoneAccount].map(([zone, id]) => [
											zone,
											accountNames.get(id) ?? id,
										]),
									)
								: undefined
						}
						query={state.q ?? ""}
						scope={ZONE_SCOPES.find((s) => s === state.scope)}
						onQueryChange={(q) => onStateChange({ q: q || undefined })}
						onScopeChange={(scope) => onStateChange({ scope })}
						waiting={waiting?.zones}
					/>
				)
			) : view === "workers" ? (
				workerRows === null ? (
					<CloudflareBandLoading className={FLEET_BAND_BOXED} />
				) : (
					<CloudflareWorkersView
						rows={workerRows}
						accounts={showAccountColumn ? accountNames : undefined}
						query={state.q ?? ""}
						scope={WORKER_SCOPES.find((s) => s === state.scope)}
						showPreviews={state.previews ?? false}
						onQueryChange={(q) => onStateChange({ q: q || undefined })}
						onScopeChange={(scope) => onStateChange({ scope })}
						onShowPreviewsChange={(previews) =>
							onStateChange({ previews: previews || undefined })
						}
						waiting={waiting?.workers}
					/>
				)
			) : (
				<CloudflareQueuesView queues={queues ?? []} waiting={waiting?.queues} />
			)}
		</div>
	)
}

/** Each account's share of the current view: edge requests, invocations, or queue backlog. */
function accountShares(
	view: CloudflareView,
	zones: ReadonlyArray<{ serviceName: string; requests: number }>,
	workers: ReadonlyArray<{ accountId: string; requests: number }>,
	queues: ReadonlyArray<{ accountId: string; backlogMessages: number }>,
	zoneAccount: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
	const totals = new Map<string, number>()
	const add = (id: string | undefined, n: number) => {
		if (id !== undefined) totals.set(id, (totals.get(id) ?? 0) + n)
	}
	if (view === "zones") for (const z of zones) add(zoneAccount.get(z.serviceName), z.requests)
	else if (view === "queues") for (const q of queues) add(q.accountId, q.backlogMessages)
	else for (const w of workers) add(w.accountId, w.requests)
	const sum = [...totals.values()].reduce((a, b) => a + b, 0)
	return new Map([...totals].map(([id, n]) => [id, sum > 0 ? n / sum : 0]))
}

function accountCounts(
	accounts: ReadonlyArray<{ accountId: string }>,
	zones: ReadonlyArray<{ serviceName: string }>,
	workers: ReadonlyArray<{ accountId: string }>,
	zoneAccount: ReadonlyMap<string, string>,
): ReadonlyMap<string, { zones: number; workers: number }> {
	return new Map(
		accounts.map((a) => [
			a.accountId,
			{
				zones: zones.filter((z) => zoneAccount.get(z.serviceName) === a.accountId).length,
				workers: workers.filter((w) => w.accountId === a.accountId).length,
			},
		]),
	)
}
