import { V2GcpConnector, V2GcpSetupScripts } from "@maple/domain/http/v2"
import { GcpLogRuntime, GcpScopeType } from "@maple/domain/primitives"
import { Schema } from "effect"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import * as Select from "../../ui/select"
import * as ToggleGroup from "../../ui/toggle-group"
import { ConfigureTarget } from "./gcp-schema"

// `GcpConfigure`: the wizard's state.

/** `GcpFlags`: what a connection collects. */
export const GcpFlags = Schema.Struct({ logs_enabled: Schema.Boolean, metrics_enabled: Schema.Boolean })
export type GcpFlags = typeof GcpFlags.Type

/** `GcpLogFilterDraft`: null is a choice not made. */
export const LogFilterDraft = Schema.Struct({
	keep: Schema.NullOr(Schema.Boolean),
	runtimes: Schema.NullOr(Schema.Array(GcpLogRuntime)),
})
export type LogFilterDraft = typeof LogFilterDraft.Type

/** `ApplyOpened`: when the run step was entered, and the report on record then. */
export const ApplyOpened = Schema.Struct({
	at: Schema.Number,
	rerun: Schema.Boolean,
	seen: Schema.NullOr(Schema.String),
})
export type ApplyOpened = typeof ApplyOpened.Type

/** `GcpSetupMethod`: how Google Cloud is set up, asked before every Set up step. */
export const SetupMethod = Schema.Literals(["script", "manual", "terraform", "alchemy"])
export type SetupMethod = typeof SetupMethod.Type

export const Capability = Schema.Literals(["logs", "metrics"])
export type Capability = typeof Capability.Type

export const ConfigureModel = Schema.Struct({
	target: ConfigureTarget,
	dialog: Dialog.Model,
	/** Not saved: the script is asked for with it. Reopening starts over. */
	filter: LogFilterDraft,
	isFilterOpen: Schema.Boolean,
	filterMode: Select.Model,
	/** The connector this wizard created, until the status read lists it. */
	created: Schema.NullOr(V2GcpConnector),
	/** The connect flow's new connection: the scope fields and what to collect. */
	scopeType: GcpScopeType,
	scopeGroup: ToggleGroup.Model,
	scopeId: Field.Model,
	hostProjectId: Field.Model,
	newFlags: GcpFlags,
	createError: Schema.NullOr(Schema.String),
	isCreating: Schema.Boolean,
	/** `ChooseStage`'s draft; `ConnectionStages`'s `asked` and `opened`. */
	chooseFlags: GcpFlags,
	asked: Schema.NullOr(GcpFlags),
	opened: Schema.NullOr(ApplyOpened),
	confirm: Dialog.Model,
	isSaving: Schema.Boolean,
	/** `useGcpScripts` for the run step, and its "Show all". */
	scripts: KeyedSchema(V2GcpSetupScripts, LoadFailure),
	isScriptExpanded: Schema.Boolean,
	/** `ConnectionStages`: the Method step or the data step, while `opened` is null. */
	connectionStage: Schema.Literals(["choose", "method"]),
	method: SetupMethod,
	/** Whether a run was asked for when the Method step was left; null before the data step. */
	rerun: Schema.NullOr(Schema.Boolean),
	flavourGroup: ToggleGroup.Model,
	/** `MethodApplyStage`: whether logs were confirmed when the step opened. */
	sinkExisted: Schema.Boolean,
	/** `GcpManualSteps`: the open step; untouched, the first one is. */
	manualOpen: Schema.NullOr(Schema.String),
	isManualTouched: Schema.Boolean,
	/** `FileCard`: the coding-agent prompt in the file's place, and whether its copy worked. */
	isPromptShown: Schema.Boolean,
	promptCopied: Schema.NullOr(Schema.Boolean),
	isConfirmingRemoval: Schema.Boolean,
})
export type ConfigureModel = typeof ConfigureModel.Type
