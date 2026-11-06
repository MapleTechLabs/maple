import { Command } from "foldkit"
import type { AppRoute } from "../../route"
import type { PageContext, PageReturn } from "../contract"
import type * as AnalyticsMessage from "./analytics/message"
import type * as AnalyticsTab from "./analytics/model"
import * as Analytics from "./analytics/update"
import type * as CiTab from "./ci/model"
import type * as IssuesTab from "./issues/model"
import type * as PullRequestsTab from "./pull-requests/model"
import type * as SettingsTab from "./settings/model"
import type * as TeamTab from "./team/model"
import * as Ci from "./ci/update"
import * as Issues from "./issues/update"
import type { Carried } from "./kit/frame-update"
import { breadcrumbsOf } from "./kit/layout"
import { emptyRetained, mergeRetained, type Retained } from "./kit/retained"
import * as PullRequests from "./pull-requests/update"
import * as Settings from "./settings/update"
import * as Team from "./team/update"
import { Message, type Model, type Tab } from "./tabs"

type Return = PageReturn<Model, Message>

export type CodeReviewRoute = Extract<
	AppRoute,
	{
		readonly _tag:
			| "CodeReview"
			| "CodeReviewPullRequests"
			| "CodeReviewCi"
			| "CodeReviewTeam"
			| "CodeReviewIssues"
			| "CodeReviewSettings"
	}
>

/** Puts a tab's step back into the page: its Model in `tab`, its Messages wrapped. */
const lift = <M, Inner>(
	model: Omit<Model, "tab">,
	result: PageReturn<M, Inner>,
	toTab: (inner: M) => Tab,
	wrap: (message: Inner) => Message,
): Return => ({
	model: { ...model, tab: toTab(result.model) },
	commands: Command.mapMessages(result.commands ?? [], wrap),
	outMessage: result.outMessage,
})

const toAnalytics = (model: AnalyticsTab.Model): Tab => ({ _tag: "Analytics", model })
const toPullRequests = (model: PullRequestsTab.Model): Tab => ({ _tag: "PullRequests", model })
const toCi = (model: CiTab.Model): Tab => ({ _tag: "Ci", model })
const toTeam = (model: TeamTab.Model): Tab => ({ _tag: "Team", model })
const toIssues = (model: IssuesTab.Model): Tab => ({ _tag: "Issues", model })
const toSettings = (model: SettingsTab.Model): Tab => ({ _tag: "Settings", model })

const wrapAnalytics = (message: AnalyticsMessage.Message) => Message.GotAnalyticsMessage({ message })
const wrapPullRequests = (message: PullRequestsTab.Message) => Message.GotPullRequestsMessage({ message })
const wrapCi = (message: CiTab.Message) => Message.GotCiMessage({ message })
const wrapTeam = (message: TeamTab.Message) => Message.GotTeamMessage({ message })
const wrapIssues = (message: IssuesTab.Message) => Message.GotIssuesMessage({ message })
const wrapSettings = (message: SettingsTab.Message) => Message.GotSettingsMessage({ message })

/** The tab a route shows. */
const tabTagOf = (route: CodeReviewRoute): Tab["_tag"] => {
	switch (route._tag) {
		case "CodeReview":
			return "Analytics"
		case "CodeReviewPullRequests":
			return "PullRequests"
		case "CodeReviewCi":
			return "Ci"
		case "CodeReviewTeam":
			return "Team"
		case "CodeReviewIssues":
			return "Issues"
		case "CodeReviewSettings":
			return "Settings"
	}
}

/** Builds the route's tab with what the page carries. */
const enter = (base: Omit<Model, "tab">, route: CodeReviewRoute, context: PageContext): Return => {
	const carried: Carried = { retained: base.retained, nowMs: base.nowMs }
	switch (route._tag) {
		case "CodeReview":
			return lift(base, Analytics.init(route, context, carried), toAnalytics, wrapAnalytics)
		case "CodeReviewPullRequests":
			return lift(base, PullRequests.init(route, context, carried), toPullRequests, wrapPullRequests)
		case "CodeReviewCi":
			return lift(base, Ci.init(route, context, carried), toCi, wrapCi)
		case "CodeReviewTeam":
			return lift(base, Team.init(route, context, carried), toTeam, wrapTeam)
		case "CodeReviewIssues":
			return lift(base, Issues.init(route, context, carried), toIssues, wrapIssues)
		case "CodeReviewSettings":
			return lift(base, Settings.init(route, context, carried), toSettings, wrapSettings)
	}
}

/** What the active tab hands on, and the last clock it read. */
const leaving = (model: Model): Readonly<{ retained: Retained; nowMs: number }> => {
	const { tab } = model
	switch (tab._tag) {
		case "Analytics":
			return {
				retained: mergeRetained(model.retained, Analytics.retainedOf(tab.model)),
				nowMs: tab.model.frame.nowMs,
			}
		case "PullRequests":
			return {
				retained: mergeRetained(model.retained, PullRequests.retainedOf(tab.model)),
				nowMs: tab.model.frame.nowMs,
			}
		case "Ci":
			return {
				retained: mergeRetained(model.retained, Ci.retainedOf(tab.model)),
				nowMs: tab.model.frame.nowMs,
			}
		case "Team":
			return {
				retained: mergeRetained(model.retained, Team.retainedOf(tab.model)),
				nowMs: tab.model.frame.nowMs,
			}
		case "Issues":
			return {
				retained: mergeRetained(model.retained, Issues.retainedOf(tab.model)),
				nowMs: tab.model.frame.nowMs,
			}
		case "Settings":
			return {
				retained: mergeRetained(model.retained, Settings.retainedOf(tab.model, model.nowMs)),
				nowMs: model.nowMs,
			}
	}
}

export const init = (route: CodeReviewRoute, context: PageContext): Return =>
	enter({ retained: emptyRetained, nowMs: 0 }, route, context)

/** Same tab: its own `routeChanged`. Another tab: the one left hands on what it read. */
export const routeChanged = (model: Model, route: CodeReviewRoute, context: PageContext): Return => {
	const { tab } = model
	if (tabTagOf(route) !== tab._tag) return enter(leaving(model), route, context)
	switch (route._tag) {
		case "CodeReview":
			return tab._tag === "Analytics"
				? lift(model, Analytics.routeChanged(tab.model, route, context), toAnalytics, wrapAnalytics)
				: { model }
		case "CodeReviewPullRequests":
			return tab._tag === "PullRequests"
				? lift(
						model,
						PullRequests.routeChanged(tab.model, route, context),
						toPullRequests,
						wrapPullRequests,
					)
				: { model }
		case "CodeReviewCi":
			return tab._tag === "Ci"
				? lift(model, Ci.routeChanged(tab.model, route, context), toCi, wrapCi)
				: { model }
		case "CodeReviewTeam":
			return tab._tag === "Team"
				? lift(model, Team.routeChanged(tab.model, route, context), toTeam, wrapTeam)
				: { model }
		case "CodeReviewIssues":
			return tab._tag === "Issues"
				? lift(model, Issues.routeChanged(tab.model, route, context), toIssues, wrapIssues)
				: { model }
		case "CodeReviewSettings":
			return { model }
	}
}

export const contextChanged = (model: Model, context: PageContext): Return => {
	const { tab } = model
	switch (tab._tag) {
		case "Analytics":
			return lift(model, Analytics.contextChanged(tab.model, context), toAnalytics, wrapAnalytics)
		case "PullRequests":
			return lift(
				model,
				PullRequests.contextChanged(tab.model, context),
				toPullRequests,
				wrapPullRequests,
			)
		case "Ci":
			return lift(model, Ci.contextChanged(tab.model, context), toCi, wrapCi)
		case "Team":
			return lift(model, Team.contextChanged(tab.model, context), toTeam, wrapTeam)
		case "Issues":
			return lift(model, Issues.contextChanged(tab.model, context), toIssues, wrapIssues)
		case "Settings":
			return { model }
	}
}

/** A Message for the active tab; one for a tab already left is dropped. */
export const update = (model: Model, message: Message, context: PageContext): Return => {
	const { tab } = model
	return Message.match<Return>(message, {
		GotAnalyticsMessage: ({ message: inner }) =>
			tab._tag === "Analytics"
				? lift(model, Analytics.update(tab.model, inner, context), toAnalytics, wrapAnalytics)
				: { model },
		GotPullRequestsMessage: ({ message: inner }) =>
			tab._tag === "PullRequests"
				? lift(
						model,
						PullRequests.update(tab.model, inner, context),
						toPullRequests,
						wrapPullRequests,
					)
				: { model },
		GotCiMessage: ({ message: inner }) =>
			tab._tag === "Ci" ? lift(model, Ci.update(tab.model, inner, context), toCi, wrapCi) : { model },
		GotTeamMessage: ({ message: inner }) =>
			tab._tag === "Team"
				? lift(model, Team.update(tab.model, inner, context), toTeam, wrapTeam)
				: { model },
		GotIssuesMessage: ({ message: inner }) =>
			tab._tag === "Issues"
				? lift(model, Issues.update(tab.model, inner, context), toIssues, wrapIssues)
				: { model },
		GotSettingsMessage: ({ message: inner }) =>
			tab._tag === "Settings"
				? lift(model, Settings.update(tab.model, inner, context), toSettings, wrapSettings)
				: { model },
	})
}

const BREADCRUMB_TAB = {
	Analytics: "analytics",
	PullRequests: "pull-requests",
	Ci: "ci",
	Team: "team",
	Issues: "issues",
	Settings: "settings",
} as const

export const breadcrumbs = (model: Model) => breadcrumbsOf(BREADCRUMB_TAB[model.tab._tag])
