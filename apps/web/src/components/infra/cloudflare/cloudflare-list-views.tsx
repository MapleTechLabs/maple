// The /infra/cloudflare list, split by what it lists: zones, Workers, queues. Presentational only:
// the route fetches and owns URL state, so the lab can render the same pages from fixtures.

import { useDeferredValue, useMemo, type ReactNode } from "react"

import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"
import { refreshingClass } from "@maple/ui/lib/refreshing"

import type { CloudflareQueueRow, CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import { PageHero } from "@/components/common/page-hero"
import { SearchToolbar } from "@/components/common/search-toolbar"
import { FLEET_BAND_BOXED } from "../primitives/fleet-band"
import { SegmentPivot } from "../primitives/segment-pivot"
import { CloudflareQueueTable } from "./cloudflare-queue-table"
import { CloudflareWorkerBand, CloudflareZoneBand } from "./cloudflare-summary-bands"
import { CloudflareWorkerTable } from "./cloudflare-worker-table"
import { CloudflareZoneTable } from "./cloudflare-zone-table"
import {
	CLOUDFLARE_VIEWS,
	sortWorkersByAttention,
	workerInScope,
	zoneInScope,
	type CloudflareView,
	type WorkerListRow,
	type WorkerScope,
	type ZoneScope,
} from "./list-model"

const VIEW_LABEL = { zones: "Zones", workers: "Workers", queues: "Queues" } satisfies Record<
	CloudflareView,
	string
>

/** Title, account chip and the view switch. Views with nothing in them leave the switch. */
export function CloudflareListHeader({
	view,
	counts,
	account,
	onViewChange,
}: {
	view: CloudflareView
	counts: Readonly<Record<CloudflareView, number | null>>
	/** The account chip, or the account menu for a multi-account grant. */
	account: ReactNode
	onViewChange: (view: CloudflareView) => void
}) {
	const options = CLOUDFLARE_VIEWS.filter((v) => v === view || counts[v] !== 0).map((v) => ({
		value: v,
		label: counts[v] === null ? VIEW_LABEL[v] : `${VIEW_LABEL[v]} ${counts[v]}`,
	}))
	return (
		<PageHero
			title="Cloudflare"
			trailing={account}
			actions={
				options.length > 1 ? (
					<SegmentPivot<CloudflareView>
						ariaLabel="Cloudflare view"
						options={options}
						value={view}
						onChange={onViewChange}
					/>
				) : null
			}
		/>
	)
}

const matches = (query: string, ...fields: ReadonlyArray<string>) =>
	query === "" || fields.some((field) => field.toLowerCase().includes(query))

export function CloudflareZonesView({
	zones,
	sparks,
	accounts,
	query,
	scope,
	onQueryChange,
	onScopeChange,
	waiting = false,
}: {
	zones: ReadonlyArray<CloudflareZoneRow>
	sparks?: ReadonlyMap<string, ReadonlyArray<number>>
	accounts?: ReadonlyMap<string, string>
	query: string
	scope: ZoneScope | undefined
	onQueryChange: (query: string) => void
	onScopeChange: (scope: ZoneScope | undefined) => void
	waiting?: boolean
}) {
	const q = useDeferredValue(query).trim().toLowerCase()
	const filtered = useMemo(
		() => zones.filter((zone) => (!scope || zoneInScope(zone, scope)) && matches(q, zone.zoneName)),
		[zones, scope, q],
	)
	return (
		<div className={cn("space-y-4", refreshingClass(waiting))} aria-busy={waiting || undefined}>
			<CloudflareZoneBand
				zones={zones}
				activeScope={scope}
				onScopeChange={onScopeChange}
				className={FLEET_BAND_BOXED}
			/>
			<SearchToolbar
				value={query}
				onChange={onQueryChange}
				placeholder={`Filter ${zones.length} zones`}
				trailing={
					filtered.length === zones.length
						? `${zones.length} zones · by requests`
						: `${filtered.length} of ${zones.length} zones`
				}
			/>
			<CloudflareZoneTable
				zones={filtered}
				sparks={sparks}
				accounts={accounts}
				emptyMessage={
					filtered.length === zones.length
						? undefined
						: "No zones match. Clear the search or scope."
				}
			/>
		</div>
	)
}

export function CloudflareWorkersView({
	rows,
	accounts,
	query,
	scope,
	showPreviews,
	onQueryChange,
	onScopeChange,
	onShowPreviewsChange,
	waiting = false,
}: {
	rows: ReadonlyArray<WorkerListRow>
	/** Account name per account id; renders the Account column. */
	accounts?: ReadonlyMap<string, string>
	query: string
	scope: WorkerScope | undefined
	showPreviews: boolean
	onQueryChange: (query: string) => void
	onScopeChange: (scope: WorkerScope | undefined) => void
	onShowPreviewsChange: (show: boolean) => void
	waiting?: boolean
}) {
	const q = useDeferredValue(query).trim().toLowerCase()
	const previews = rows.filter((row) => row.isPreview).length
	const filtered = useMemo(
		() =>
			sortWorkersByAttention(
				rows.filter(
					(row) =>
						(showPreviews || !row.isPreview) &&
						(!scope || workerInScope(row, scope)) &&
						matches(q, row.scriptName),
				),
			),
		[rows, showPreviews, scope, q],
	)
	return (
		<div className={cn("space-y-4", refreshingClass(waiting))} aria-busy={waiting || undefined}>
			<CloudflareWorkerBand
				rows={rows}
				activeScope={scope}
				onScopeChange={onScopeChange}
				className={FLEET_BAND_BOXED}
			/>
			<SearchToolbar
				value={query}
				onChange={onQueryChange}
				placeholder={`Filter ${rows.length} Workers`}
				trailing={`${filtered.length} of ${rows.length} · problems first`}
			>
				{previews > 0 ? (
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						<Switch checked={showPreviews} onCheckedChange={onShowPreviewsChange} />
						Show {previews} preview {previews === 1 ? "deploy" : "deploys"}
					</label>
				) : null}
			</SearchToolbar>
			<CloudflareWorkerTable
				rows={filtered}
				accounts={accounts}
				emptyMessage={
					filtered.length === 0 && rows.length > 0
						? "No Workers match. Clear the search or scope."
						: undefined
				}
			/>
		</div>
	)
}

export function CloudflareQueuesView({
	queues,
	waiting,
}: {
	queues: ReadonlyArray<CloudflareQueueRow>
	waiting?: boolean
}) {
	return <CloudflareQueueTable queues={queues} waiting={waiting} />
}
