import * as Policy from "@maple/domain/policy"
import { V2IngestRule } from "@maple/domain/http/v2"
import { IngestRuleId } from "@maple/domain"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import { Draft } from "./form"
import { PreviewSignal, Samples } from "./preview"

// `/settings/ingestion/rules/new` and `/settings/ingestion/rules/:id`: the rule editor and its preview.

export const RuleData = AsyncData.Schema(V2IngestRule, LoadFailure)
export const SamplesData = AsyncData.Schema(Samples, LoadFailure)

export const Model = Schema.Struct({
	/** The rule being edited; `null` creates. */
	editingId: Schema.NullOr(IngestRuleId),
	/** The URL named a rule id that does not parse. */
	isBadId: Schema.Boolean,
	existing: RuleData.schema,
	draft: Draft,
	/** One key autocomplete per attribute condition, by condition id. */
	keyBoxes: Schema.Record(Schema.String, Combobox.Model),
	spanKeys: Schema.Array(Schema.String),
	logKeys: Schema.Array(Schema.String),
	resourceKeys: Schema.Array(Schema.String),
	services: Schema.Array(Schema.String),
	previewSignal: PreviewSignal,
	/** `""` previews every service. */
	previewService: Schema.String,
	samples: SamplesData.schema,
	/** The sample request in flight; an older answer is dropped. */
	samplesKey: Schema.String,
	grants: Schema.Array(Policy.PermissionName),
	isSessionLoaded: Schema.Boolean,
	isSaving: Schema.Boolean,
	saveFailure: Schema.NullOr(LoadFailure),
})
export type Model = typeof Model.Type

/** The viewer may change what this page edits (`ingest_rules:manage`). */
export const canManage = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "ingest_rules:manage")
