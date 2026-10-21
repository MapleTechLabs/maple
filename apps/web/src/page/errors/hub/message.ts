import { V2ErrorIssueServiceCount, V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as ContextMenu from "../../../ui/context-menu"
import * as Menu from "../../../ui/menu"
import * as QuickPick from "../kit/quick-pick"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import { SignalPresences } from "../../kit/signal-presence"
import { HubWrite, WriteOutcome } from "./writes"
import { ErrorsSummary, IssuePage, SparkSeries, VolumeRow } from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload (no cache snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** The sidebar's single-select params. */
export const FilterParam = Schema.Literals(["service", "env", "kind", "regressed"])
export type FilterParam = typeof FilterParam.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchSummary: result(Schema.NullOr(ErrorsSummary)),
	CompletedFetchServiceCounts: result(Schema.Array(V2ErrorIssueServiceCount)),
	CompletedFetchEnvironments: result(Schema.Array(Schema.String)),
	CompletedFetchRanking: result(Schema.Array(Schema.String)),
	CompletedFetchPage: result(IssuePage),
	CompletedFetchVolume: result(Schema.Array(VolumeRow)),
	CompletedFetchSpark: result(Schema.Array(SparkSeries)),
	CompletedFetchInvestigations: result(Schema.Array(V2Investigation)),
	/** The filter rail mounted (inline, or in the sheet below `lg`). */
	MountedFilterRail: {},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetry: {},
	ClickedLoadMore: {},
	ToggledFilterOption: { param: FilterParam, name: Schema.String },
	ClickedClearFilters: {},
	RemovedFilterChip: { param: FilterParam },
	ChangedSearchDraft: { value: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Number },
	ClickedViewAll: {},
	ClickedClearSearch: {},
	ClickedShowAllSeverities: {},
	ToggledRow: { id: Schema.String },
	/** A row checkbox clicked with Shift held extends from the anchor (`toggledSelection`). */
	ClickedRowSelect: { id: Schema.String, isShift: Schema.Boolean },
	PressedListKey: { key: Schema.String, isShift: Schema.Boolean },
	ClickedBulkClaim: {},
	PressedRowPointer: { id: Schema.String, point: ContextMenu.Point },
	OpenedRowMenu: { id: Schema.String },
	GotRowMenuMessage: { message: ContextMenu.Message },
	CompletedCopy: { label: Schema.String, isOk: Schema.Boolean },
	CompletedOpenInNewTab: {},
	ClickedPickerTrigger: { id: Schema.String, kind: Schema.Literals(["severity", "state"]) },
	GotPickerMessage: { message: QuickPick.Message },
	ClickedClearSelection: {},
	GotBulkSeverityMenuMessage: { message: Menu.Message },
	GotBulkMoveMenuMessage: { message: Menu.Message },
	CompletedHubWrite: {
		ids: Schema.Array(Schema.String),
		write: HubWrite,
		isBulk: Schema.Boolean,
		outcome: WriteOutcome,
	},
	ToggledAllRows: {},
	HoveredRow: { id: Schema.String },
	ClickedInvestigation: { id: Schema.String },
	GotTabsMessage: { message: Tabs.Message },
	GotSortSelectMessage: { message: Select.Message },
	GotSeveritySelectMessage: { message: Select.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
})
export type Message = typeof Message.Type
