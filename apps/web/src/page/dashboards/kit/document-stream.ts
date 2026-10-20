import type { DashboardDocument } from "@maple/domain/http"
import { Option } from "effect"
import { rowToDocument } from "../../../data/collections/dashboards"
import { liveQueryStream } from "../../../data/live-query"
import { orgLive } from "../../../data/collections/org-collections"

/** `useDashboardsRead`'s `dashboards.find(id)`: the board's row, decoded, as the collection changes. */
export const documentStream = <M>(
	orgId: string,
	dashboardId: string,
	toMessage: (maybeDocument: Option.Option<DashboardDocument>) => M,
) =>
	orgLive(orgId, ({ dashboards: collection }) =>
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
	)

/** `collectTags(dashboards)`: every tag on the org's boards, sorted, as the collection changes. */
export const orgTagsStream = <M>(orgId: string, toMessage: (tags: ReadonlyArray<string>) => M) =>
	orgLive(orgId, ({ dashboards: collection }) =>
		liveQueryStream(
			(q) => q.from({ d: collection }),
			(rows) =>
				toMessage(
					Array.from(
						new Set(
							rows.flatMap((row) =>
								Option.match(rowToDocument(row), {
									onNone: () => [],
									onSome: (document) => document.tags ?? [],
								}),
							),
						),
					).sort(),
				),
		),
	)
