import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { V2RetentionPolicy, V2RetentionSource, V2SourceUsage } from "@maple/domain/http/v2"
import { SourceId } from "@maple/primitives"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SOURCE_TABS } from "../../../route/search"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { SourceList } from "../kit/data"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"
import { Model as IntegrationModel } from "../../integrations/embed"

// `/sources/$sourceId`.

/** The one-time token from a roll, held while this page is open. */
export const RevealedToken = Schema.Struct({
	sourceId: SourceId,
	secret: Schema.String,
	rolled: Schema.Boolean,
})
export type RevealedToken = typeof RevealedToken.Type

/** The one write in flight. */
export const BusyAction = Schema.NullOr(Schema.Literals(["pause", "resume", "roll", "delete"]))
export type BusyAction = typeof BusyAction.Type

/** The settings form, rebuilt when the source it was built from changes. */
export const SettingsForm = Schema.Struct({
	builtFrom: Schema.String,
	name: Schema.String,
	description: Schema.String,
	rules: Rules.Model,
	isSaving: Schema.Boolean,
})
export type SettingsForm = typeof SettingsForm.Type

/** What a source sets per signal: a period, or `null` to follow the organization. */
export const RetentionSet = V2RetentionSource.fields.set
export type RetentionSet = typeof RetentionSet.Type

export const RetentionPolicyData = AsyncData.Schema(V2RetentionPolicy, LoadFailure)

/** The Settings tab's Retention section: the org's policy, and this source's periods as edited. */
export const RetentionForm = Schema.Struct({
	policy: RetentionPolicyData.schema,
	/** `null` until the policy loads. */
	draft: Schema.NullOr(RetentionSet),
	isSaving: Schema.Boolean,
	/** The save also sent the source's own PATCH, whose toast covers both. */
	savedWithSource: Schema.Boolean,
})
export type RetentionForm = typeof RetentionForm.Type

export const Model = Schema.Struct({
	/** `fromPublicSourceId(sourceId)`: `null` for an id that does not decode (not found, no request). */
	sourceId: Schema.NullOr(SourceId),
	tab: Schema.Literals(SOURCE_TABS),
	/** The session's permissions (`null` until read): anyone reads a source, `sources:manage` changes it. */
	grants: Schema.NullOr(Schema.Array(Policy.PermissionName)),
	/** `Date.now()` at render, read once on entry for the relative times. */
	nowMs: Schema.NullOr(Schema.Number),
	list: KeyedSchema(SourceList, LoadFailure),
	/** The overview's usage read; requested once the overview shows a found source. */
	usage: KeyedSchema(V2SourceUsage, LoadFailure),
	revealed: Schema.NullOr(RevealedToken),
	busy: BusyAction,
	pauseMenu: Menu.Model,
	rollDialog: Dialog.Model,
	deleteDialog: Dialog.Model,
	tokenCopy: CopyButton.Model,
	chart: Chart.Model,
	...ChartEnvFields,
	/** The Setup tab's snippet tabs and copy buttons; `null` while another tab shows. */
	setup: Schema.NullOr(Setup.Model),
	settings: Schema.NullOr(SettingsForm),
	/** The Settings tab's retention; `null` while another tab shows. */
	retention: Schema.NullOr(RetentionForm),
	/** An integration source's integration (its card, connect flow and reads); `null` for push sources. */
	connection: Schema.NullOr(IntegrationModel),
})
export type Model = typeof Model.Type

export const canManage = (model: Pick<Model, "grants">): boolean =>
	model.grants !== null && Policy.can(model.grants, "sources:manage")

/** The viewer may change how long this source keeps its signals. */
export const canManageRetention = (model: Pick<Model, "grants">): boolean =>
	model.grants !== null && Policy.can(model.grants, "retention:manage")
