import { rowToAlertIncidentDocument } from "@maple/web-data/collections/alerts"
import { Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { type OrgCollectionSet, OrgCollections } from "../../data/collections/org-collections"
import { liveQueryStream } from "../../data/live-query"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"

const withSet = (
	orgId: string,
	stream: (set: OrgCollectionSet) => Stream.Stream<Message>,
): Stream.Stream<Message, never, OrgCollections> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const collections = yield* OrgCollections
			return stream(yield* collections.forOrg(orgId))
		}),
	)

/** `useAlertIncidentsList()`: newest trigger first, reduced to what the banner and health read. */
const incidents = (orgId: string) =>
	withSet(orgId, (set) =>
		liveQueryStream(
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
		),
	)

/** `useAlertRulesList()`'s rules query, reduced to `enabled` (the banner counts them). */
const rules = (orgId: string) =>
	withSet(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ r: set.alertRules }).orderBy(({ r }) => r.updated_at, "desc"),
			(rows) => Message.UpdatedRules({ orgId, enabled: rows.map((row) => row.enabled) }),
		),
	)

/** `useAlertRulesList()`'s states query: synced alongside the rules, unread by this page. */
const ruleStates = (orgId: string) =>
	withSet(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ s: set.alertRuleStates }),
			() => Message.UpdatedRuleStates({ orgId }),
		),
	)

const byOrg = (stream: (orgId: string) => Stream.Stream<Message, never, OrgCollections>) => ({
	modelToDependencies: ({ context }: PageSubscriptionInput<Model>) => ({ orgId: context.orgId }),
	dependenciesToStream: ({ orgId }: { readonly orgId: string }) => stream(orgId),
})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		incidents: entry({ orgId: Schema.String }, byOrg(incidents)),
		rules: entry({ orgId: Schema.String }, byOrg(rules)),
		ruleStates: entry({ orgId: Schema.String }, byOrg(ruleStates)),
	}),
)
