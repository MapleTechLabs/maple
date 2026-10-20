import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as AnalyticsModel from "./analytics/model"
import * as AnalyticsMessage from "./analytics/message"
import * as CiModel from "./ci/model"
import * as IssuesModel from "./issues/model"
import { Retained } from "./kit/retained"
import * as PullRequestsModel from "./pull-requests/model"
import * as SettingsModel from "./settings/model"

// The Code Review tabs as one page instance (switching tabs reuses what the last one read): the
// active tab's Model and what it hands on.

export const Tab = Schema.Union([
	Schema.TaggedStruct("Analytics", { model: AnalyticsModel.Model }),
	Schema.TaggedStruct("PullRequests", { model: PullRequestsModel.Model }),
	Schema.TaggedStruct("Ci", { model: CiModel.Model }),
	Schema.TaggedStruct("Issues", { model: IssuesModel.Model }),
	Schema.TaggedStruct("Settings", { model: SettingsModel.Model }),
])
export type Tab = typeof Tab.Type

export const Model = Schema.Struct({
	tab: Tab,
	/** Answers the tabs left behind, carried into the next tab. */
	retained: Retained,
	/** The last clock a tab read, which judges whether a carried answer is still fresh. */
	nowMs: Schema.Number,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotAnalyticsMessage: { message: AnalyticsMessage.Message },
	GotPullRequestsMessage: { message: PullRequestsModel.Message },
	GotCiMessage: { message: CiModel.Message },
	GotIssuesMessage: { message: IssuesModel.Message },
	GotSettingsMessage: { message: SettingsModel.Message },
})
export type Message = typeof Message.Type
