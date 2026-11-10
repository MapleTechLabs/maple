import { Array as Arr, Stream } from "effect"
import { type OrgCollections, orgLive } from "../data/collections/org-collections"
import { liveQueryStream } from "../data/live-query"

/**
 * The Alerts › Inbox count: open incidents nobody has acknowledged, over the org's live
 * `alert_incidents`. The alerts pages already read that collection, so reading it while one is open
 * requests no other shape.
 */
export const alertsInboxCounts = <Message>(
	orgId: string,
	toMessage: (count: number) => Message,
): Stream.Stream<Message, never, OrgCollections> =>
	orgLive(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ i: set.alertIncidents }),
			(rows) =>
				toMessage(
					Arr.filter(rows, (row) => row.status === "open" && (row.acknowledged_at ?? null) === null)
						.length,
				),
		),
	)
