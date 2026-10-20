import { V2Source, V2SourceWithSecret } from "@maple/domain/http/v2"
import { PullSourcePlatform, PushSourcePlatform } from "@maple/domain/primitives"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import { SourceList } from "../kit/data"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"

export const Message = defineMessageUnion({
	ClickedPushPlatform: { platform: PushSourcePlatform },
	ClickedPullPlatform: { platform: PullSourcePlatform },
	ChangedName: { value: Schema.String },
	ToggledAdvanced: {},
	GotRulesMessage: { message: Rules.Message },
	ClickedBack: {},
	SubmittedForm: {},
	CompletedCreate: { result: Schema.Result(V2SourceWithSecret, LoadFailure) },
	CompletedFetchList: { key: Schema.String, result: Schema.Result(SourceList, LoadFailure) },
	CompletedFetchSource: { key: Schema.String, result: Schema.Result(V2Source, LoadFailure) },
	ElapsedPoll: { key: Schema.String },
	GotSetupMessage: { message: Setup.Message },
	GotTokenCopyMessage: { message: CopyButton.Message },
})
export type Message = typeof Message.Type
