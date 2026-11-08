import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Select from "@maple/views/ui/select"
import * as Tabs from "@maple/views/ui/tabs"
import { SignalPresences } from "@maple/views/data/signal-presence"
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
	CompletedReadGrants: { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) },
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
