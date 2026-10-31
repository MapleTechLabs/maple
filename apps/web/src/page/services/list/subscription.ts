import { rowToAlertIncidentDocument } from "@maple/web-data/collections/alerts"
import { Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import { type OrgCollections, orgLive } from "../../../data/collections/org-collections"
import { liveQueryStream } from "../../../data/live-query"
import { collectionLoadFailed, ENRICHMENT_LOAD_TIMEOUT_MS } from "../../alerts/shared/collection-load"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"

/** `useAlertIncidentsList()`: the org's incidents, newest trigger first, reduced to what health reads. */
const incidents = (orgId: string): Stream.Stream<Message, never, OrgCollections> =>
	orgLive(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ i: set.alertIncidents }).orderBy(({ i }) => i.last_triggered_at, "desc"),
			(rows) =>
				Message.UpdatedIncidents({
					orgId,
					incidents: rows.map(rowToAlertIncidentDocument).map((incident) => ({
						status: incident.status,
						groupKey: incident.groupKey,
						severity: incident.severity,
						signalType: incident.signalType,
					})),
				}),
		),
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
		/** Health stops waiting on an alert sync that failed or stalled. */
		incidentsLoadFailed: entry(
			{ orgId: Schema.String, isWaiting: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					isWaiting: AsyncData.isLoading(model.incidents),
				}),
				dependenciesToStream: ({ orgId, isWaiting }) =>
					isWaiting
						? collectionLoadFailed(
								`alert_incidents:${orgId}`,
								() => Message.FailedLoadIncidents({ orgId }),
								ENRICHMENT_LOAD_TIMEOUT_MS,
							)
						: Stream.empty,
			},
		),
	}),
)
