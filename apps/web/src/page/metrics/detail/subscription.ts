import { Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import * as AddToDashboard from "./add-to-dashboard"
import { Message } from "./message"
import type { Model } from "./model"

/** `useDashboardStore()` in `AddToDashboardDialog`: the org's dashboards, live. */
export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		dashboards: entry(
			{ orgId: Schema.String },
			{
				modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
				dependenciesToStream: ({ orgId }) =>
					Stream.map(AddToDashboard.dashboardChoices(orgId), (message) =>
						Message.GotAddToDashboardMessage({ message }),
					),
			},
		),
	}),
)
