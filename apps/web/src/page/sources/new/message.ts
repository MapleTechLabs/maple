import { V2Source, V2SourceWithSecret } from "@maple/domain/http/v2"
import { PushSourcePlatform } from "@maple/domain/primitives"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import { SourceList } from "../kit/data"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"
import { DataIntegration } from "../../integrations/embed"
import { Message as IntegrationMessage } from "../../integrations/message"

export const Message = defineMessageUnion({
	ClickedPushPlatform: { platform: PushSourcePlatform },
	ClickedIntegration: { integration: DataIntegration },
	ChangedName: { value: Schema.String },
	ToggledAdvanced: {},
	GotRulesMessage: { message: Rules.Message },
	ClickedBack: {},
	/** The footer: the integration's next step, or the one before it. */
	ClickedContinue: {},
	ClickedStepBack: {},
	SubmittedForm: {},
	CompletedCreate: { result: Schema.Result(V2SourceWithSecret, LoadFailure) },
	CompletedFetchList: { key: Schema.String, result: Schema.Result(SourceList, LoadFailure) },
	CompletedFetchSource: { key: Schema.String, result: Schema.Result(V2Source, LoadFailure) },
	ElapsedPoll: { key: Schema.String },
	GotSetupMessage: { message: Setup.Message },
	GotTokenCopyMessage: { message: CopyButton.Message },
	GotIntegrationsMessage: { message: IntegrationMessage },
})
export type Message = typeof Message.Type
