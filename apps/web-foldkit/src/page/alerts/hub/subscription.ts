import { Clock, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { destinationRows, incidentRows, ruleRows, ruleStateRows } from "../shared/collections"
import { Message } from "./message"
import type { Model } from "./model"

/** How often the staleness derivation's clock advances (`CLOCK_TICK`). */
const CLOCK_TICK = "30 seconds"

const byOrg = { orgId: Schema.String }

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		rules: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				ruleRows(orgId, (rows) => Message.UpdatedRules({ orgId, rows })),
		}),
		states: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				ruleStateRows(orgId, (rows) => Message.UpdatedRuleStates({ orgId, rows })),
		}),
		incidents: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				incidentRows(orgId, (rows) => Message.UpdatedIncidents({ orgId, rows })),
		}),
		destinations: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
		}),
		clock: entry(
			{},
			{
				modelToDependencies: () => ({}),
				dependenciesToStream: () =>
					Stream.tick(CLOCK_TICK).pipe(
						Stream.drop(1),
						Stream.mapEffect(() => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs }))),
					),
			},
		),
	}),
)
