import { V2Source } from "@maple/domain/http/v2"
import { PushSourcePlatform } from "@maple/domain/primitives"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import { SourceList } from "../kit/data"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"
import { DataIntegration } from "../../integrations/embed"
import { FlowStage } from "../../integrations/flow"
import { Model as IntegrationModel } from "../../integrations/model"

// `/sources/new`: pick a platform, name it, copy the token.

/** The create's answer: the source and its one-time token, held in memory only. */
export const Created = Schema.Struct({ source: V2Source, secret: Schema.String })
export type Created = typeof Created.Type

export const Model = Schema.Struct({
	/** `?platform=`: step 2 when set. */
	platform: Schema.NullOr(PushSourcePlatform),
	name: Schema.String,
	isAdvancedOpen: Schema.Boolean,
	rules: Rules.Model,
	isSaving: Schema.Boolean,
	/** `useAtomRefresh(sourcesListAtom)` in the form mounts the list, so step 2 reads it. */
	list: KeyedSchema(SourceList, LoadFailure),
	created: Schema.NullOr(Created),
	/** `FirstDataStatus`'s retained `sources.retrieve`, polled every 5 s until data arrives. */
	firstData: KeyedSchema(V2Source, LoadFailure),
	setup: Setup.Model,
	tokenCopy: CopyButton.Model,
	/** `?integration=`: a data integration's connect step instead of the push form. */
	integration: Schema.NullOr(DataIntegration),
	/** The integrations module: the picker's connected badges, then the chosen integration's card. */
	integrations: IntegrationModel,
	/** A target was added in this visit: WarpStream's step is done (its targets read as Prometheus ones). */
	hasAddedTarget: Schema.Boolean,
	/** The integration's current step: Connect, Choose data or Go live. */
	stage: FlowStage,
})
export type Model = typeof Model.Type
