import { Schema } from "effect"
import * as AddToDashboard from "./add-to-dashboard"
import { CaretMessage } from "./where-editor"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as Combobox from "../../../ui/combobox"
import * as CopyButton from "../../../ui/copy-button"
import * as Select from "../../../ui/select"
import { MetricRow } from "../shared"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { AttributeKeyRow, AutocompleteLookup, BreakdownRow, TimeseriesRows } from "./model"
import { LookupNames } from "../../kit/autocomplete-lookups"

/** `Load` on entry or a search change; `Refresh` from Reload (no cache snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchCatalog: result(Schema.Array(MetricRow)),
	CompletedFetchAutocomplete: { lookup: AutocompleteLookup, ...result(LookupNames) },
	CompletedFetchAttributeKeys: result(Schema.Array(AttributeKeyRow)),
	CompletedFetchTimeseries: result(TimeseriesRows),
	CompletedFetchBreakdown: result(Schema.Array(BreakdownRow)),
	ChangedWhereInput: { value: Schema.String },
	PressedWhereEnter: {},
	GotCaretMessage: { message: CaretMessage },
	MovedWhereSuggestion: { step: Schema.Number },
	DismissedWhereSuggestions: {},
	AppliedWhereSuggestion: { index: Schema.Number },
	PressedWhereTab: {},
	PressedWhereEnterOnList: {},
	CompletedPlaceWhereCaret: {},
	CompletedFetchAttributeValues: result(Schema.Array(Schema.String)),
	CompletedWhereDebounce: { generation: Schema.Number },
	ChangedStepInput: { value: Schema.String },
	CommittedStepInput: {},
	ClickedBreakdownValue: { groupBy: Schema.String, value: Schema.String },
	ClickedCreateAlert: {},
	BuiltAlertLink: { url: Schema.String },
	ClickedAddToDashboard: {},
	GotAddToDashboardMessage: { message: AddToDashboard.Message },
	ClickedCopyLink: {},
	ReadLocationHref: { href: Schema.String },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	GotAggregationSelectMessage: { message: Select.Message },
	GotGroupByComboboxMessage: { message: Combobox.Message },
	GotBreakdownComboboxMessage: { message: Combobox.Message },
	GotCopyLinkMessage: { message: CopyButton.Message },
	GotChartMessage: { message: Chart.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type
