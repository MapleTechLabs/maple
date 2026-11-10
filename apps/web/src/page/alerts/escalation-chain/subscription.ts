import { Schema } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { destinationRows, ruleRows } from "../shared/collections"
import { Message } from "./message"
import type { Model } from "./model"

const byOrg = { orgId: Schema.String }

/** The synced destinations steps pick from, and the rules that name the chain ("Used by"). */
export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		destinations: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
		}),
		rules: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				ruleRows(orgId, (rows) => Message.UpdatedRules({ orgId, rows })),
		}),
	}),
)
