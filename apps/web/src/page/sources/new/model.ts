import { V2Source } from "@maple/domain/http/v2"
import { PushSourcePlatform } from "@maple/primitives"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as CopyButton from "@maple/views/ui/copy-button"
import { SourceList } from "../kit/data"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"
import { DataIntegration, FlowStage, Model as IntegrationModel } from "../../integrations/embed"

// `/sources/new`: pick a source, then name it and copy its token on one page. Onboarding's drawer
// runs the same flow.

/** Where the flow shows: its own page, or onboarding's drawer (no links away, Done closes it). */
export type FlowHost = "page" | "drawer"

/** The create's answer: the source and its one-time token, held in memory only. */
export const Created = Schema.Struct({ source: V2Source, secret: Schema.String })
export type Created = typeof Created.Type

export const Model = Schema.Struct({
	/** The session's permissions on the page (`null` until read; the drawer never reads them). */
	grants: Schema.NullOr(Schema.Array(Policy.PermissionName)),
	/** The picker's search: narrows every group by label and description. */
	search: Schema.String,
	/** `?platform=`: the push source's page when set. */
	platform: Schema.NullOr(PushSourcePlatform),
	name: Schema.String,
	isAdvancedOpen: Schema.Boolean,
	rules: Rules.Model,
	isSaving: Schema.Boolean,
	/** The sources list, which the push page and an integration's step read. */
	list: KeyedSchema(SourceList, LoadFailure),
	created: Schema.NullOr(Created),
	/** The created source's `sources.retrieve`, polled every 5 s until data arrives. */
	firstData: KeyedSchema(V2Source, LoadFailure),
	/** The picked platform's snippet tabs, kept across Create. */
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
