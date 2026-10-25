import { OrgId } from "@maple/domain"
import type { Collection } from "@tanstack/db"
import { Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { AlertRuleRow } from "@maple/web-data/collections/alerts"
import { OrgCollections } from "../../data/collections/org-collections"
import { liveQueryStream } from "../../data/live-query"
import type { Resources } from "../../platform/resources"
import { Message, type Model } from "./model"

/** Every emission names the org it was read for, so `update` can drop the previous org's rows. */
export const ruleCounts = (
	orgId: OrgId,
	rules: Collection<AlertRuleRow, string | number>,
): Stream.Stream<Message> =>
	liveQueryStream(
		(q) => q.from({ rule: rules }),
		(rows) => Message.UpdatedAlertRules({ orgId, count: rows.length }),
	)

const alertRuleCounts = (orgId: OrgId): Stream.Stream<Message, never, OrgCollections> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const collections = yield* OrgCollections
			const set = yield* collections.forOrg(orgId)
			return ruleCounts(orgId, set.alertRules)
		}),
	)

export const subscriptions = Subscription.make<Model, Message, Resources>()((entry) => ({
	/** `useLiveQuery((q) => q.from({ rule: alertRules }), [alertRules])`, re-keyed by org. */
	alertRules: entry(
		{ orgId: Schema.NullOr(OrgId) },
		{
			modelToDependencies: (model) => ({ orgId: model.orgId }),
			dependenciesToStream: ({ orgId }) => (orgId === null ? Stream.empty : alertRuleCounts(orgId)),
		},
	),
}))
