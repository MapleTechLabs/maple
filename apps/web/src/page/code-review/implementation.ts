import { Option } from "effect"
import { Submodel, Subscription } from "foldkit"
import type { Resources } from "../../platform/resources"
import { implementPage, type PageSubscriptionInput, type PageViewInputs } from "../contract"
import { entry } from "./index"
import { view as analyticsView } from "./analytics/view"
import { view as ciView } from "./ci/view"
import { view as issuesView } from "./issues/view"
import { subscriptions as pullRequestsSubscriptions } from "./pull-requests/subscription"
import { view as pullRequestsView } from "./pull-requests/view"
import { view as settingsView } from "./settings/view"
import { view as teamView } from "./team/view"
import { Message, Model } from "./tabs"
import { breadcrumbs, contextChanged, init, routeChanged, update } from "./tabs-update"

/** The active tab's view, under a boundary per tab. */
const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { tab } = model
	switch (tab._tag) {
		case "Analytics":
			return h.submodel({
				slotId: "code-review-analytics",
				model: tab.model,
				view: analyticsView,
				viewInputs: inputs,
				toParentMessage: (message) => Message.GotAnalyticsMessage({ message }),
			})
		case "PullRequests":
			return h.submodel({
				slotId: "code-review-pull-requests",
				model: tab.model,
				view: pullRequestsView,
				viewInputs: inputs,
				toParentMessage: (message) => Message.GotPullRequestsMessage({ message }),
			})
		case "Ci":
			return h.submodel({
				slotId: "code-review-ci",
				model: tab.model,
				view: ciView,
				viewInputs: inputs,
				toParentMessage: (message) => Message.GotCiMessage({ message }),
			})
		case "Team":
			return h.submodel({
				slotId: "code-review-team",
				model: tab.model,
				view: teamView,
				viewInputs: inputs,
				toParentMessage: (message) => Message.GotTeamMessage({ message }),
			})
		case "Issues":
			return h.submodel({
				slotId: "code-review-issues",
				model: tab.model,
				view: issuesView,
				viewInputs: inputs,
				toParentMessage: (message) => Message.GotIssuesMessage({ message }),
			})
		case "Settings":
			return h.submodel({
				slotId: "code-review-settings",
				model: tab.model,
				view: settingsView,
				viewInputs: inputs,
				toParentMessage: (message) => Message.GotSettingsMessage({ message }),
			})
	}
})

/** The Pull requests tab's polling, while it is the active tab. */
const subscriptions = Subscription.lift(pullRequestsSubscriptions)<PageSubscriptionInput<Model>, Message>({
	read: ({ model, context }) =>
		model.tab._tag === "PullRequests" ? Option.some({ model: model.tab.model, context }) : Option.none(),
	toParentMessage: (message) => Message.GotPullRequestsMessage({ message }),
}) satisfies Subscription.Subscriptions<PageSubscriptionInput<Model>, Message, Resources>

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs,
})
