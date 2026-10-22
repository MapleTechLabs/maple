import type { V2GcpConnector, V2GcpSetupScripts } from "@maple/domain/http/v2"
import type { GcpLogRuntime } from "@maple/domain/primitives"
import {
	gcpCollectLock,
	gcpLogFilterChoice,
	gcpScriptNeeded,
} from "../../components/integrations/gcp-connector-state"
import { isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import { Option } from "effect"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import * as Select from "../../ui/select"
import * as ToggleGroup from "../../ui/toggle-group"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import {
	ConfirmRemoval,
	CopyPrompt,
	CreateConnector,
	flagsOf,
	initConfigure,
	initConfirm,
	LoadConfigureScripts,
	UpdateConnector,
} from "./gcp-configure"
import { CAPABILITIES, SCOPE_TYPES } from "./gcp-configure-copy"
import { chooseChanges, createRequest, isScopeReady } from "./gcp-configure-derive"
import type { Capability, ConfigureModel, GcpFlags, LogFilterDraft, SetupMethod } from "./gcp-configure-schema"
import type { ConfigureTarget } from "./gcp-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { gcpConnectors, refreshInventory, updateGcpCard } from "./update-gcp"
import { chain, requestStatus } from "./update-status"

// `GcpConfigure`'s state changes: open, the steps, the create and the save, the run step's script.

type Return = PageReturn<Model, Message>

export const withConfigure = (
	model: Model,
	patch: (configure: ConfigureModel) => Partial<ConfigureModel>,
): Model =>
	model.gcpCard.configure === null
		? model
		: {
				...model,
				gcpCard: {
					...model.gcpCard,
					configure: { ...model.gcpCard.configure, ...patch(model.gcpCard.configure) },
				},
			}

export const metricsAvailable = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.statuses.gcp.data), {
		onNone: () => false,
		onSome: (status) => status.metrics_available,
	})

/** `connectors.find(target.id) ?? created`, before `asked` is applied. */
export const savedConnector = (model: Model, configure: ConfigureModel): V2GcpConnector | undefined => {
	const target = configure.target
	if (target._tag === "New") return undefined
	return (
		gcpConnectors(model).find((entry) => entry.id === target.id) ??
		(configure.created?.id === target.id ? configure.created : undefined)
	)
}

/** What was just saved, shown over the read until the status read delivers a newer connector. */
export const configureConnector = (model: Model, configure: ConfigureModel): V2GcpConnector | undefined => {
	const saved = savedConnector(model, configure)
	return saved === undefined || configure.asked === null ? saved : { ...saved, ...configure.asked }
}

const dialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withConfigure(model, () => ({ dialog: step.model })),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotGcpConfigureDialogMessage({ message }),
	),
})

/** The script asked for the chosen filter: `undefined` keeps an existing sink's. */
export const scriptsKey = (
	context: PageContext,
	connector: V2GcpConnector,
	filter: LogFilterDraft,
	sinkExists = connector.applied_logs_enabled === true,
) => {
	const applicationLogs = gcpLogFilterChoice(filter, sinkExists).applicationLogs ?? null
	return {
		applicationLogs,
		key: requestKey(context.orgId, "gcpIntegration.setupScripts:configure", {
			id: connector.id,
			applicationLogs,
		}),
	}
}

const requestScripts = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const configure = model.gcpCard.configure
	const connector = configure === null ? undefined : configureConnector(model, configure)
	if (configure === null || connector === undefined || configure.opened === null) return { model }
	// Without the script the sink is the one found when the step opened (`MethodApplyStage`).
	const sinkExists = configure.method === "script" ? connector.applied_logs_enabled === true : configure.sinkExisted
	const { key, applicationLogs } = scriptsKey(context, connector, configure.filter, sinkExists)
	return Option.match(Keyed.request(configure.scripts, key, mode), {
		onNone: () => ({ model }),
		onSome: (scripts) => ({
			model: withConfigure(model, () => ({ scripts })),
			commands: [LoadConfigureScripts({ key, id: connector.id, applicationLogs })],
		}),
	})
}

/**
 * `setOpened(open(rerun))`: the run step, timed from now (the page clock), with the report on
 * record so a newer run tells itself apart. The script is read afresh, as a remounted query is.
 */
const enterApply = (model: Model, context: PageContext, rerun: boolean): Return => {
	const configure = model.gcpCard.configure
	const saved = configure === null ? undefined : savedConnector(model, configure)
	if (saved === undefined) return { model }
	const opened = { at: model.nowMs, rerun, seen: saved.setup_reported_at }
	const shown = configure === null ? saved : (configureConnector(model, configure) ?? saved)
	return requestScripts(
		withConfigure(model, () => ({
			opened,
			scripts: Keyed.idle(),
			isScriptExpanded: false,
			sinkExisted: shown.applied_logs_enabled === true,
			manualOpen: null,
			isManualTouched: false,
			isPromptShown: false,
			promptCopied: null,
			isConfirmingRemoval: false,
		})),
		context,
		"Load",
	)
}

/** The Method step, with whether a run was asked for when the data step was left. */
const toMethod = (model: Model, rerun: boolean): Return => ({
	model: withConfigure(model, () => ({ connectionStage: "method", rerun, opened: null })),
})

/** Continue on the Method step: the Set up step for the chosen method. */
export const clickedMethodContinue = (model: Model, context: PageContext): Return => {
	const configure = model.gcpCard.configure
	if (configure === null || configure.opened !== null) return { model }
	return enterApply(model, context, configure.rerun ?? true)
}

export const openConfigure = (model: Model, target: ConfigureTarget): Return => {
	const pending = model.gcpCard.pendingWrite
	const configure = {
		...initConfigure(target, gcpConnectors(model), metricsAvailable(model)),
		isCreating: pending === "create",
		isSaving: pending === "update",
	}
	const opened = updateGcpCard(model, { configure, configureOpens: model.gcpCard.configureOpens + 1 }).model
	const shown = dialogStep(opened, Dialog.open(configure.dialog))
	const saved = savedConnector(shown.model, configure)
	if (target._tag === "New" || target.stage === "choose" || saved === undefined) return shown
	// Found waiting on a first run, the status times it from the connection's creation.
	return chain(shown.model, [
		() => shown,
		(next) => toMethod(next, gcpScriptNeeded(saved, model.nowMs) !== "setup-pending"),
	])
}

export const closedConfigure = (model: Model): Return => updateGcpCard(model, { configure: null })

/** The X and Escape close the wizard outright. */
export const gotConfigureDialog = (model: Model, message: Dialog.Message): Return => {
	const configure = model.gcpCard.configure
	if (configure === null) return { model }
	const step = Dialog.update(configure.dialog, message)
	return step.model.isOpen ? dialogStep(model, step) : closedConfigure(model)
}

/** A new kind of scope: the two kinds of ID never carry over, so the field starts over. */
export const gotScopeType = (model: Model, message: ToggleGroup.Message): Return => {
	const configure = model.gcpCard.configure
	if (configure === null) return { model }
	const step = ToggleGroup.update(configure.scopeGroup, message)
	const next = SCOPE_TYPES.find(
		(scopeType) => scopeType !== configure.scopeType && step.model.values.includes(scopeType),
	)
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		Message.GotGcpScopeTypeMessage({ message: inner }),
	)
	const grouped = withConfigure(model, () => ({
		scopeGroup: { ...step.model, values: [next ?? configure.scopeType] },
	}))
	if (next === undefined) return { model: grouped, commands }
	return {
		model: withConfigure(grouped, () => ({ scopeType: next, scopeId: Field.init(), createError: null })),
		commands,
	}
}

export const gotScopeField = (
	model: Model,
	field: "scopeId" | "hostProjectId",
	message: Field.Message,
): Return => ({
	model: withConfigure(model, (configure) => ({
		[field]: Field.update(configure[field], message).model,
		// An edit clears a refused create's message.
		createError: message._tag === "ChangedValue" ? null : configure.createError,
	})),
})

/** Continue on the scope step: only with a valid scope. */
export const submittedScope = (model: Model): Return => {
	const configure = model.gcpCard.configure
	if (configure === null || configure.step !== "scope" || !isScopeReady(configure)) return { model }
	return { model: withConfigure(model, () => ({ step: "data" })) }
}

export const clickedBack = (model: Model): Return =>
	model.gcpCard.configure?.isCreating === true
		? { model }
		: { model: withConfigure(model, () => ({ step: "scope" })) }

export const submittedCreate = (model: Model): Return => {
	const configure = model.gcpCard.configure
	if (configure === null || configure.isCreating) return { model }
	return Option.match(createRequest(configure), {
		onNone: () => ({ model }),
		onSome: (request) => ({
			model: withConfigure(updateGcpCard(model, { pendingWrite: "create" }).model, () => ({
				isCreating: true,
				createError: null,
			})),
			commands: [CreateConnector({ opens: model.gcpCard.configureOpens, request })],
		}),
	})
}

/** The write settled; `true` when the wizard it was sent from is still the one open. */
const settleWrite = (model: Model, opens: number): { readonly model: Model; readonly isCurrent: boolean } => ({
	model: updateGcpCard(model, { pendingWrite: null }).model,
	isCurrent: model.gcpCard.configure !== null && model.gcpCard.configureOpens === opens,
})

/** A write from a wizard closed or reopened since: the reopened one is free again, its reads refresh. */
const staleWrite = (model: Model, context: PageContext, isSaved: boolean): Return => {
	const freed = withConfigure(model, () => ({ isCreating: false, isSaving: false }))
	return isSaved
		? chain(freed, [(next) => requestStatus(next, context, "gcp", "Supersede"), refreshInventory])
		: { model: freed }
}

/** A refused scope keeps its message on screen; a created one leads into the run step. */
export const completedCreate = (
	model: Model,
	context: PageContext,
	opens: number,
	connector: V2GcpConnector | null,
	failure: LoadFailure | null,
): Return => {
	const write = settleWrite(model, opens)
	if (!write.isCurrent) return staleWrite(write.model, context, connector !== null)
	const settled = withConfigure(write.model, () => ({ isCreating: false }))
	if (connector === null)
		return {
			model: withConfigure(settled, () => ({
				createError:
					failure === null || isUnexpectedError(failure)
						? "Couldn't connect. Try again."
						: failure.message,
			})),
		}
	const target: ConfigureTarget = { _tag: "Connection", id: connector.id, stage: "apply" }
	return chain(
		withConfigure(settled, () => ({ created: connector, target })),
		[
			(next) => toMethod(next, false),
			(next) => requestStatus(next, context, "gcp", "Supersede"),
			refreshInventory,
		],
	)
}

/** A switch: the new connection's flags on the data step, else the connection's draft. */
export const toggledCollect = (model: Model, capability: Capability): Return => {
	const configure = model.gcpCard.configure
	if (configure === null) return { model }
	const isNew = configure.target._tag === "New"
	const flags = isNew ? configure.newFlags : configure.chooseFlags
	if (gcpCollectLock(flags, capability, metricsAvailable(model)) !== null) return { model }
	const flag = CAPABILITIES[capability].flag
	const next = { ...flags, [flag]: !flags[flag] }
	return {
		model: withConfigure(model, () =>
			isNew ? { newFlags: next, createError: null } : { chooseFlags: next },
		),
	}
}

const withFilter = (model: Model, patch: (filter: LogFilterDraft) => Partial<LogFilterDraft>): Return => ({
	model: withConfigure(model, (configure) => ({
		filter: { ...configure.filter, ...patch(configure.filter) },
	})),
})

export const clickedLogFilter = (model: Model): Return => ({
	model: withConfigure(model, (configure) => ({ isFilterOpen: !configure.isFilterOpen })),
})

export const clickedForwardOutput = (model: Model): Return => withFilter(model, () => ({ runtimes: [] }))

export const clickedUseOpenTelemetry = (model: Model): Return => withFilter(model, () => ({ runtimes: null }))

/** A runtime's tick flipped in the draft (shared with `/lab/gcp`). */
export const runtimeToggled = (filter: LogFilterDraft, runtime: GcpLogRuntime): Partial<LogFilterDraft> => {
	const runtimes = filter.runtimes ?? []
	return {
		runtimes: runtimes.includes(runtime)
			? runtimes.filter((entry) => entry !== runtime)
			: [...runtimes, runtime],
	}
}

export const toggledRuntime = (model: Model, runtime: GcpLogRuntime): Return =>
	withFilter(model, (filter) => runtimeToggled(filter, runtime))

/** Keep or replace an existing sink's filter. */
export const gotFilterMode = (model: Model, message: Select.Message): Return => {
	const configure = model.gcpCard.configure
	if (configure === null) return { model }
	const step = Select.update(configure.filterMode, message)
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		Message.GotGcpFilterModeMessage({ message: inner }),
	)
	const picked = step.outMessage?._tag === "ChangedValue" ? step.outMessage.value : null
	const next = withConfigure(model, () => ({ filterMode: step.model }))
	return picked === null
		? { model: next, commands }
		: { ...withFilter(next, () => ({ keep: picked === "keep" })), commands }
}

const confirmStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withConfigure(model, () => ({ confirm: step.model })),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotGcpConfirmDialogMessage({ message }),
	),
})

export const gotConfirmDialog = (model: Model, message: Dialog.Message): Return => {
	const configure = model.gcpCard.configure
	if (configure === null || configure.isSaving) return { model }
	return confirmStep(model, Dialog.update(configure.confirm, message))
}

/** Sends only what changed: the API leaves an omitted capability as it is. */
const save = (model: Model): Return => {
	const configure = model.gcpCard.configure
	const connector = configure === null ? undefined : configureConnector(model, configure)
	if (configure === null || connector === undefined || configure.isSaving) return { model }
	const draft = configure.chooseFlags
	const { changed } = chooseChanges(connector, draft)
	const payload =
		changed.length === 2
			? draft
			: changed[0] === "logs"
				? { logs_enabled: draft.logs_enabled }
				: { metrics_enabled: draft.metrics_enabled }
	return {
		model: withConfigure(updateGcpCard(model, { pendingWrite: "update" }).model, () => ({ isSaving: true })),
		commands: [UpdateConnector({ opens: model.gcpCard.configureOpens, id: connector.id, payload, flags: draft })],
	}
}

/** Unchanged leads on; a change that acts in Maple at once asks first; any other saves. */
export const clickedChooseApply = (model: Model): Return => {
	const configure = model.gcpCard.configure
	const connector = configure === null ? undefined : configureConnector(model, configure)
	if (configure === null || connector === undefined || configure.isSaving) return { model }
	const { changed, immediate } = chooseChanges(connector, configure.chooseFlags)
	if (changed.length === 0) return toMethod(model, true)
	if (immediate.length > 0) return confirmStep(model, Dialog.open(configure.confirm))
	return save(model)
}

export const confirmedSave = save

/** A failed save keeps the confirmation open for a retry; a saved one leads into the run step. */
export const completedUpdate = (
	model: Model,
	context: PageContext,
	opens: number,
	flags: GcpFlags,
	failure: LoadFailure | null,
): Return => {
	const write = settleWrite(model, opens)
	if (failure === null && !write.isCurrent) return staleWrite(write.model, context, true)
	const settled = write.isCurrent
		? withConfigure(write.model, () => ({ isSaving: false }))
		: staleWrite(write.model, context, false).model
	if (failure !== null)
		return {
			model: settled,
			outMessage: PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to save the change",
				description: failure.message,
			}),
		}
	// The data step unmounts with its confirmation, so that closes without a transition.
	const applied = withConfigure(settled, () => ({ asked: flags, confirm: initConfirm() }))
	return chain(applied, [
		(next) => toMethod(next, false),
		(next) => requestStatus(next, context, "gcp", "Supersede"),
		refreshInventory,
	])
}

/**
 * "Edit" or Back: from the Set up step the Method step again; from the Method step the data step,
 * its draft from the connection as shown.
 */
export const clickedRunEdit = (model: Model): Return => {
	const configure = model.gcpCard.configure
	const connector = configure === null ? undefined : configureConnector(model, configure)
	if (configure === null || connector === undefined) return { model }
	if (configure.opened !== null)
		return {
			model: withConfigure(model, () => ({ opened: null, connectionStage: "method", scripts: Keyed.idle() })),
		}
	return {
		model: withConfigure(model, () => ({
			connectionStage: "choose",
			chooseFlags: flagsOf(connector),
			scripts: Keyed.idle(),
			confirm: initConfirm(),
		})),
	}
}

/** A Method row, or the code flavour under it: the flavour toggle follows the method. */
export const clickedMethod = (model: Model, method: SetupMethod): Return => ({
	model: withConfigure(model, (configure) => ({
		method,
		flavourGroup:
			method === "terraform" || method === "alchemy"
				? { ...configure.flavourGroup, values: [method] }
				: configure.flavourGroup,
	})),
})

export const gotFlavour = (model: Model, message: ToggleGroup.Message): Return => {
	const configure = model.gcpCard.configure
	if (configure === null) return { model }
	const step = ToggleGroup.update(configure.flavourGroup, message)
	const flavour = configure.method === "alchemy" ? "alchemy" : "terraform"
	const next = FLAVOURS.find((value) => value !== flavour && step.model.values.includes(value))
	return {
		model: withConfigure(model, () => ({
			flavourGroup: { ...step.model, values: [next ?? flavour] },
			method: next ?? configure.method,
		})),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotGcpFlavourMessage({ message: inner }),
		),
	}
}

const FLAVOURS = ["terraform", "alchemy"] as const

export const completedScripts = (
	model: Model,
	key: string,
	result: Parameters<typeof Keyed.accept<V2GcpSetupScripts, LoadFailure>>[2],
): Return => ({
	model: withConfigure(model, (configure) => ({ scripts: Keyed.accept(configure.scripts, key, result) })),
})

export const retriedScripts = (model: Model, context: PageContext): Return =>
	requestScripts(model, context, "Refresh")

export const clickedScriptExpand = (model: Model): Return => ({
	model: withConfigure(model, (configure) => ({ isScriptExpanded: !configure.isScriptExpanded })),
})

/** A newer read that lists the connection replaces what was just saved (`asked.of === saved`). */
export const statusArrived = (model: Model): Return => {
	const target = model.gcpCard.configure?.target
	const listed =
		target?._tag === "Connection" && gcpConnectors(model).some((entry) => entry.id === target.id)
	return listed ? { model: withConfigure(model, () => ({ asked: null })) } : { model }
}

/** `GcpManualSteps`: one step open at a time; the open one closes on its own click. */
export const clickedManualStep = (model: Model, title: string, firstTitle: string | null): Return => ({
	model: withConfigure(model, (configure) => {
		const open = configure.isManualTouched ? configure.manualOpen : firstTitle
		return { manualOpen: open === title ? null : title, isManualTouched: true }
	}),
})

/** "Copy prompt for coding agent": the prompt takes the file's place, and the footer says if it copied. */
export const clickedCopyPrompt = (model: Model, prompt: string): Return => ({
	model: withConfigure(model, () => ({ isPromptShown: true, promptCopied: null })),
	commands: [CopyPrompt({ text: prompt })],
})

export const completedPromptCopy = (model: Model, isCopied: boolean): Return => ({
	model: withConfigure(model, () => ({ promptCopied: isCopied })),
})

export const clickedPromptBack = (model: Model): Return => ({
	model: withConfigure(model, () => ({ isPromptShown: false })),
})

/** "I've removed them": recorded on the admin's word, then the status read again. */
export const clickedConfirmRemoval = (model: Model): Return => {
	const configure = model.gcpCard.configure
	const connector = configure === null ? undefined : configureConnector(model, configure)
	if (configure === null || connector === undefined || configure.isConfirmingRemoval) return { model }
	return {
		model: withConfigure(model, () => ({ isConfirmingRemoval: true })),
		commands: [ConfirmRemoval({ id: connector.id })],
	}
}

export const completedConfirmRemoval = (
	model: Model,
	context: PageContext,
	failure: LoadFailure | null,
): Return => {
	const settled = withConfigure(model, () => ({ isConfirmingRemoval: false }))
	if (failure !== null)
		return {
			model: settled,
			outMessage: PageOutMessage.RequestedToast({
				type: "error",
				title: "Couldn't record the removal",
				description: failure.message,
			}),
		}
	return chain(settled, [(next) => requestStatus(next, context, "gcp", "Supersede"), refreshInventory])
}
