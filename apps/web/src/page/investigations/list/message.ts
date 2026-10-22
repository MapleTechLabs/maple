import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import { SignalPresences } from "../../kit/signal-presence"
import { InvestigationPage, TriageBudget } from "./model"

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchFirstPage: result(InvestigationPage),
	CompletedFetchMorePage: { cursor: Schema.String, ...result(InvestigationPage) },
	CompletedFetchBudget: result(TriageBudget),
	CompletedReadIsAdmin: { orgId: Schema.String, isAdmin: Schema.Boolean },
	ClickedRetry: {},
	ClickedLoadMore: {},
	ChangedSubject: { value: Schema.String },
	SubmittedSubject: {},
	ClickedSuggestion: { title: Schema.String },
	CompletedCreate: { result: Schema.Result(Schema.String, LoadFailure) },
	ChangedSearchDraft: { value: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Number },
	ClickedClearFilters: {},
	ClickedRow: { id: Schema.String },
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	GotTabsMessage: { message: Tabs.Message },
	GotKindSelectMessage: { message: Select.Message },
	GotSortSelectMessage: { message: Select.Message },
})
export type Message = typeof Message.Type
