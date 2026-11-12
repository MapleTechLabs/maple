import {
	CostBreakdownResponse,
	CostBreakdownSortBy,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { RequestMode } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import { TimeWindow } from "../../data/time-range"
import { COST_GROUP_BYS } from "../../route/search"
import * as TimeRangePicker from "../kit/time-range-picker"
import { CredentialProvider } from "./providers"

/** A read's answer; `key` is what it was requested under, so a stale one is dropped. */
const result = <A, AI>(schema: Schema.Codec<A, AI>) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

const GroupBy = Schema.Literals(COST_GROUP_BYS)

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadSources: result(CostSourcesResponse),
	CompletedLoadTotals: result(CostTotalsResponse),
	CompletedLoadTimeseries: result(CostTimeseriesResponse),
	CompletedLoadBreakdown: result(CostBreakdownResponse),
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	/** Any failed read's Try again: asks again for the ones that failed. */
	ClickedRetry: {},
	PickedGroupBy: { groupBy: GroupBy },
	ClickedSort: { sort: CostBreakdownSortBy },
	ClickedRemoveFilter: { dimension: GroupBy, value: Schema.String },
	ClickedClearFilters: {},
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { message: Chart.Message },
	CompletedReadGrants: { grants: Schema.Array(Policy.PermissionName) },
	/** Opens the add-source dialog on the providers. */
	ClickedAddSource: {},
	/** Picks a provider added by pasting a credential: the dialog moves to its form. */
	PickedProvider: { provider: CredentialProvider },
	ClickedBackToProviders: {},
	/** Opens the dialog on the provider's form, for the source that exists. */
	ClickedReplaceCredential: { provider: CredentialProvider },
	GotAddDialogMessage: { message: Dialog.Message },
	GotCredentialDraftMessage: { message: Field.Message },
	/** A plain field before the credential, by its place in the provider's list. */
	GotCredentialIdentifierMessage: { index: Schema.Int, message: Field.Message },
	SubmittedCredential: {},
	CompletedSaveCredential: {
		provider: CredentialProvider,
		result: Schema.Result(Schema.Void, LoadFailure),
	},
	ClickedRemoveSource: { provider: CredentialProvider },
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemove: {},
	CompletedRemoveCredential: {
		provider: CredentialProvider,
		result: Schema.Result(Schema.Void, LoadFailure),
	},
	...ChartEnvMessages,
})
export type Message = typeof Message.Type
