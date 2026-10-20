import { V2SourceUsage } from "@maple/domain/http/v2"
import { SourceId } from "@maple/domain/primitives"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { SOURCE_TABS } from "../../../route/search"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { SourceList } from "../kit/data"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"
import { Model as IntegrationModel } from "../../integrations/model"

// `/sources/$sourceId`.

/** `RevealedToken`: the one-time token from a roll, held while this page is open. */
export const RevealedToken = Schema.Struct({ sourceId: SourceId, secret: Schema.String, rolled: Schema.Boolean })
export type RevealedToken = typeof RevealedToken.Type

/** The one write in flight (`useAsyncAction`'s pending, the delete dialog's running state). */
export const BusyAction = Schema.NullOr(Schema.Literals(["pause", "resume", "roll", "delete"]))
export type BusyAction = typeof BusyAction.Type

/** `SourceSettings key={source.updated_at}`: the form, rebuilt when the source it was built from changes. */
export const SettingsForm = Schema.Struct({
	builtFrom: Schema.String,
	name: Schema.String,
	description: Schema.String,
	rules: Rules.Model,
	isSaving: Schema.Boolean,
})
export type SettingsForm = typeof SettingsForm.Type

export const Model = Schema.Struct({
	/** `fromPublicSourceId(sourceId)`: `null` for an id that does not decode (not found, no request). */
	sourceId: Schema.NullOr(SourceId),
	tab: Schema.Literals(SOURCE_TABS),
	/** `Date.now()` at render, read once on entry for the relative times. */
	nowMs: Schema.NullOr(Schema.Number),
	list: KeyedSchema(SourceList, LoadFailure),
	/** `SourceOverview`'s usage read; requested once the overview shows a found source. */
	usage: KeyedSchema(V2SourceUsage, LoadFailure),
	revealed: Schema.NullOr(RevealedToken),
	busy: BusyAction,
	pauseMenu: Menu.Model,
	rollDialog: Dialog.Model,
	deleteDialog: Dialog.Model,
	tokenCopy: CopyButton.Model,
	chart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	/** The Setup tab's snippet tabs and copy buttons; `null` while another tab shows. */
	setup: Schema.NullOr(Setup.Model),
	settings: Schema.NullOr(SettingsForm),
	/** An integration source's integration (its card, connect flow and reads); `null` for push sources. */
	connection: Schema.NullOr(IntegrationModel),
})
export type Model = typeof Model.Type
