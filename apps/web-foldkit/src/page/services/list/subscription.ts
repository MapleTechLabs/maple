import { rowToAlertIncidentDocument } from "@maple/web-data/collections/alerts"
import { Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { OrgCollections } from "../../../data/collections/org-collections"
import { liveQueryStream } from "../../../data/live-query"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"

/** `useAlertIncidentsList()`: the org's incidents, newest trigger first, reduced to what health reads. */
const incidents = (orgId: string): Stream.Stream<Message, never, OrgCollections> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const collections = yield* OrgCollections
			const set = yield* collections.forOrg(orgId)
			return liveQueryStream(
				(q) => q.from({ i: set.alertIncidents }).orderBy(({ i }) => i.last_triggered_at, "desc"),
				(rows) =>
					Message.UpdatedIncidents({
						orgId,
						incidents: rows.map(rowToAlertIncidentDocument).map((incident) => ({
							status: incident.status,
							groupKey: incident.groupKey,
							severity: incident.severity,
						})),
					}),
			)
		}),
	)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		incidents: entry(
			{ orgId: Schema.String },
			{
				modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
				dependenciesToStream: ({ orgId }) => incidents(orgId),
			},
		),
	}),
)
