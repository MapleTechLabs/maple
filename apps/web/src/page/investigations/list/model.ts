import { V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { InvestigationsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import { SignalPresenceData } from "../../kit/signal-presence"

// `/investigations`.

/** One page of `investigations.list`. */
export const InvestigationPage = Schema.Struct({
	data: Schema.Array(V2Investigation),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(Schema.String),
})
export type InvestigationPage = typeof InvestigationPage.Type

/** `aiTriage.getSettings`, the fields the budget notice reads. */
export const TriageBudget = Schema.Struct({
	enabled: Schema.Boolean,
	ordinaryPaused: Schema.Boolean,
	priorityPaused: Schema.Boolean,
	pausedDimension: Schema.NullOr(Schema.Literals(["runs", "runs_reserved", "passes", "passes_reserved"])),
	resumesAt: Schema.NullOr(Schema.String),
})
export type TriageBudget = typeof TriageBudget.Type

/** A page past the first, by the cursor that fetched it. */
export const MorePage = Schema.Struct({
	cursor: Schema.String,
	page: KeyedSchema(InvestigationPage, LoadFailure),
})

export const Model = Schema.Struct({
	search: InvestigationsSearch,
	nowMs: Schema.Number,
	firstPage: KeyedSchema(InvestigationPage, LoadFailure),
	morePages: Schema.Array(MorePage),
	budget: KeyedSchema(TriageBudget, LoadFailure),
	presence: SignalPresenceData.schema,
	/** The investigate bar's text and whether its create is in flight. */
	subject: Schema.String,
	isCreating: Schema.Boolean,
	/** `useIsOrgAdmin`: false until the session says otherwise; self-hosted is root. */
	isOrgAdmin: Schema.Boolean,
	searchDraft: Schema.String,
	searchGeneration: Schema.Number,
	tabs: Tabs.Model,
	kindSelect: Select.Model,
	sortSelect: Select.Model,
})
export type Model = typeof Model.Type
