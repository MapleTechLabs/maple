import { electricSyncBaseUrl } from "@maple/web/lib/services/common/electric-sync-url"
import { Array as Arr, Effect, Order, Schema } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { MapleSyncHttpClient } from "../platform/api-clients"

/** What the Pinned group reads from a `dashboards` row (`DashboardRowSchema` in apps/web). */
export const PinnedDashboardRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	updated_at: Schema.String,
})
export type PinnedDashboardRow = typeof PinnedDashboardRow.Type

/** Electric's shape log: row operations carry a `value`, control messages only `headers`. */
const SyncLog = Schema.Array(
	Schema.Union([Schema.Struct({ value: PinnedDashboardRow }), Schema.Struct({ headers: Schema.Unknown })]),
)

const byUpdatedDesc = Order.flip(Order.mapInput(Order.String, (row: PinnedDashboardRow) => row.updated_at))

/**
 * The initial snapshot of the `dashboards` shape through the sync proxy, newest first like
 * `useDashboardsRead`'s live query. A snapshot, not a live stream: the data layer (S6) owns that.
 */
export const fetchDashboardRows = (orgId: string) =>
	Effect.gen(function* () {
		const client = yield* MapleSyncHttpClient
		const request = HttpClientRequest.get(`${electricSyncBaseUrl}/api/sync/shape`).pipe(
			HttpClientRequest.setUrlParams({ shape: "dashboards", org: orgId, offset: "-1" }),
		)
		const response = yield* client.execute(request)
		const log = yield* HttpClientResponse.schemaBodyJson(SyncLog)(response)
		const rows = log.flatMap((entry) => ("value" in entry ? [entry.value] : []))
		return Arr.sort(rows, byUpdatedDesc)
	})
