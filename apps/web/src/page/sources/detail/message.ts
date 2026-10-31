import { V2Source, V2SourceUsage, V2SourceWithSecret } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { SourceList } from "../kit/data"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"
import { Message as IntegrationMessage } from "../../integrations/message"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchList: { key: Schema.String, result: Schema.Result(SourceList, LoadFailure) },
	CompletedFetchUsage: { key: Schema.String, result: Schema.Result(V2SourceUsage, LoadFailure) },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
	GotPauseMenuMessage: { message: Menu.Message },
	ClickedResume: {},
	ClickedRollToken: {},
	ClickedDelete: {},
	/** "Pause instead" in the delete dialog, and the Settings tab's Pause: pauses until resumed. */
	ClickedPauseUntilResumed: {},
	GotRollDialogMessage: { message: Dialog.Message },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ConfirmedRoll: {},
	ConfirmedDelete: {},
	CompletedPause: { result: Schema.Result(V2Source, LoadFailure) },
	CompletedResume: { result: Schema.Result(V2Source, LoadFailure) },
	CompletedRoll: { result: Schema.Result(V2SourceWithSecret, LoadFailure) },
	CompletedDelete: { result: Schema.Result(Schema.Void, LoadFailure) },
	GotTokenCopyMessage: { message: CopyButton.Message },
	GotSetupMessage: { message: Setup.Message },
	GotRulesMessage: { message: Rules.Message },
	ChangedSettingsName: { value: Schema.String },
	ChangedSettingsDescription: { value: Schema.String },
	SubmittedSettings: {},
	CompletedSave: { result: Schema.Result(V2Source, LoadFailure) },
	GotConnectionMessage: { message: IntegrationMessage },
})
export type Message = typeof Message.Type
