import type { DashboardDocument } from "@maple/domain/http"
import { Effect, Option, Stream } from "effect"
import { rowToDocument } from "../../../data/collections/dashboards"
import { liveQueryStream } from "../../../data/live-query"
import { dashboardsOf } from "./store"

/** `useDashboardsRead`'s `dashboards.find(id)`: the board's row, decoded, as the collection changes. */
export const documentStream = <M>(
	orgId: string,
	dashboardId: string,
	toMessage: (maybeDocument: Option.Option<DashboardDocument>) => M,
) =>
	Stream.unwrap(
		Effect.map(dashboardsOf(orgId), (collection) =>
			liveQueryStream(
				(q) => q.from({ d: collection }),
				(rows) =>
					toMessage(
						Option.flatMap(
							Option.fromNullishOr(rows.find((row) => row.id === dashboardId)),
							rowToDocument,
						),
					),
			),
		),
	)
