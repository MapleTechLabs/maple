import type { V2GcpConnector, V2GcpSetupScripts } from "@maple/domain/http/v2"
import type { GcpLogRuntime } from "@maple/primitives"
import { gcpCollectLock, gcpLogFilterChoice, gcpScriptNeeded } from "../connector-state"
import { isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import { Option, Array as Arr } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Select from "@maple/views/ui/select"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import type { PageContext } from "../../../contract"
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
import { CAPABILITIES, CAPABILITY_IDS, SCOPE_TYPES } from "./gcp-configure-copy"
import { chooseChanges, createRequest, runConfirmed } from "./gcp-configure-derive"
import type {
	Capability,
	ConfigureModel,
	GcpFlags,
	LogFilterDraft,
	SetupMethod,
} from "./gcp-configure-schema"
import type { ConfigureTarget } from "./gcp-schema"
import { type GcpCardModel, GcpMessage } from "./gcp"
import type { Model } from "../../../integrations/model"
import { HubRequest } from "../../../integrations/provider"
import {
	connectorsIn,
	type Env,
	readStatus,
	refreshInventory,
	type Return,
	steps,
	withCard,
} from "./update-gcp"

// The configure wizard's state changes, as steps of the Google Cloud module.

type Card = GcpCardModel
type Connectors = ReadonlyArray<V2GcpConnector>

const withConfigure = (model: Card, patch: (configure: ConfigureModel) => Partial<ConfigureModel>): Card =>
	model.configure === null
		? model
		: { ...model, configure: { ...model.configure, ...patch(model.configure) } }

const metricsIn = (slot: Env["status"]): boolean =>
	Option.match(AsyncData.getData(slot.data), {
		onNone: () => false,
		onSome: (status) => status.metrics_available,
	})

export const metricsAvailable = (model: Model): boolean => metricsIn(model.statuses.gcp)

const savedConnector = (connectors: Connectors, configure: ConfigureModel): V2GcpConnector | undefined => {
	const target = configure.target
	if (target._tag === "New") return undefined
	return Option.getOrElse(
		Arr.findFirst(connectors, (entry) => entry.id === target.id),
		() => (configure.created?.id === target.id ? configure.created : undefined),
	)
}

/** What was just saved, shown over the read until the status read delivers a newer connector. */
export const configureConnector = (
	connectors: Connectors,
	configure: ConfigureModel,
): V2GcpConnector | undefined => {
	const saved = savedConnector(connectors, configure)
	return saved === undefined || configure.asked === null ? saved : { ...saved, ...configure.asked }
}

const dialogStep = (model: Card, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withConfigure(model, () => ({ dialog: step.model })),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		GcpMessage.GotGcpConfigureDialogMessage({ message }),
	),
})

/** The script asked for the chosen filter: `undefined` keeps an existing sink's. */
const scriptsKey = (
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

/** The wizard's connector as shown, against the status the module sees. */
const shownConnector = (env: Env, configure: ConfigureModel) =>
	configureConnector(connectorsIn(env.status), configure)

const requestScripts = (model: Card, env: Env, mode: Keyed.RequestMode): Return => {
	const configure = model.configure
	const connector = configure === null ? undefined : shownConnector(env, configure)
	if (configure === null || connector === undefined || configure.opened === null) return { model }
	// Without the script the sink is the one found when the step opened.
	const sinkExists =
		configure.method === "script" ? connector.applied_logs_enabled === true : configure.sinkExisted
	const { key, applicationLogs } = scriptsKey(env.context, connector, configure.filter, sinkExists)
	return Option.match(Keyed.request(configure.scripts, key, mode), {
		onNone: () => ({ model }),
		onSome: (scripts) => ({
			model: withConfigure(model, () => ({ scripts })),
			commands: [LoadConfigureScripts({ key, id: connector.id, applicationLogs })],
		}),
	})
}

/**
 * The run step, timed from now (the page clock), with the report on record so a newer run tells
 * itself apart. The script is read afresh.
 */
const enterApply = (model: Card, env: Env, rerun: boolean): Return => {
	const configure = model.configure
	const saved = configure === null ? undefined : savedConnector(connectorsIn(env.status), configure)
	if (saved === undefined) return { model }
	const opened = { at: env.nowMs, rerun, seen: saved.setup_reported_at }
	const shown = configure === null ? saved : (shownConnector(env, configure) ?? saved)
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
		env,
		"Load",
	)
}

/** The Method step, with whether a run was asked for when the data step was left. */
const toMethod = (model: Card, rerun: boolean): Return => ({
	model: withConfigure(model, () => ({ connectionStage: "method", rerun, opened: null })),
})

/** Continue on the Method step: the Set up step for the chosen method. */
export const clickedMethodContinue = (model: Card, env: Env): Return => {
	const configure = model.configure
	if (configure === null || configure.opened !== null) return { model }
	return enterApply(model, env, configure.rerun ?? true)
}

export const openConfigure = (model: Card, env: Env, target: ConfigureTarget): Return => {
	const pending = model.pendingWrite
	const configure = {
		...initConfigure(target, connectorsIn(env.status), metricsIn(env.status)),
		isCreating: pending === "create",
		isSaving: pending === "update",
	}
	const opened = withCard(model, { configure, configureOpens: model.configureOpens + 1 })
	const shown = dialogStep(opened, Dialog.open(configure.dialog))
	const saved = savedConnector(connectorsIn(env.status), configure)
	if (target._tag === "New" || target.stage === "choose" || saved === undefined) return shown
	// Found waiting on a first run, the status times it from the connection's creation.
	return steps(shown.model, [
		() => shown,
		(next) => toMethod(next, gcpScriptNeeded(saved, env.nowMs) !== "setup-pending"),
	])
}

export const closedConfigure = (model: Card): Return => ({ model: withCard(model, { configure: null }) })

/** The X and Escape close the wizard outright. */
export const gotConfigureDialog = (model: Card, message: Dialog.Message): Return => {
	const configure = model.configure
	if (configure === null) return { model }
	const step = Dialog.update(configure.dialog, message)
	return step.model.isOpen ? dialogStep(model, step) : closedConfigure(model)
}

/** A new kind of scope: the two kinds of ID never carry over, so the field starts over. */
export const gotScopeType = (model: Card, message: ToggleGroup.Message): Return => {
	const configure = model.configure
	if (configure === null) return { model }
	const step = ToggleGroup.update(configure.scopeGroup, message)
	const found = Arr.findFirst(
		SCOPE_TYPES,
		(scopeType) => scopeType !== configure.scopeType && step.model.values.includes(scopeType),
	)
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		GcpMessage.GotGcpScopeTypeMessage({ message: inner }),
	)
	const grouped = withConfigure(model, () => ({
		scopeGroup: { ...step.model, values: [Option.getOrElse(found, () => configure.scopeType)] },
	}))
	if (Option.isNone(found)) return { model: grouped, commands }
	const next = found.value
	return {
		model: withConfigure(grouped, () => ({ scopeType: next, scopeId: Field.init(), createError: null })),
		commands,
	}
}

export const gotScopeField = (
	model: Card,
	field: "scopeId" | "hostProjectId",
	message: Field.Message,
): Return => ({
	model: withConfigure(model, (configure) => ({
		[field]: Field.update(configure[field], message).model,
		// An edit clears a refused create's message.
		createError: message._tag === "ChangedValue" ? null : configure.createError,
	})),
})

export const submittedCreate = (model: Card): Return => {
	const configure = model.configure
	if (configure === null || configure.isCreating) return { model }
	return Option.match(createRequest(configure), {
		onNone: () => ({ model }),
		onSome: (request) => ({
			model: withConfigure(withCard(model, { pendingWrite: "create" }), () => ({
				isCreating: true,
				createError: null,
			})),
			commands: [CreateConnector({ opens: model.configureOpens, request })],
		}),
	})
}

/** The write settled; `true` when the wizard it was sent from is still the one open. */
const settleWrite = (model: Card, opens: number): { readonly model: Card; readonly isCurrent: boolean } => ({
	model: withCard(model, { pendingWrite: null }),
	isCurrent: model.configure !== null && model.configureOpens === opens,
})

/** A write from a wizard closed or reopened since: the reopened one is free again, its reads refresh. */
const staleWrite = (model: Card, isSaved: boolean): Return => {
	const freed = withConfigure(model, () => ({ isCreating: false, isSaving: false }))
	return isSaved ? steps(freed, [readStatus("Supersede"), refreshInventory]) : { model: freed }
}

/** A refused scope keeps its message on screen; a created one reads its setup for Go live. */
export const completedCreate = (
	model: Card,
	env: Env,
	opens: number,
	connector: V2GcpConnector | null,
	failure: LoadFailure | null,
): Return => {
	const write = settleWrite(model, opens)
	if (!write.isCurrent) return staleWrite(write.model, connector !== null)
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
	return steps(
		withConfigure(settled, () => ({ created: connector, target })),
		[(next) => enterApply(next, env, false), readStatus("Supersede"), refreshInventory],
	)
}

/** A switch: the new connection's flags on the data step, else the connection's draft. */
export const toggledCollect = (model: Card, env: Env, capability: Capability): Return => {
	const configure = model.configure
	if (configure === null) return { model }
	const isNew = configure.target._tag === "New"
	const flags = isNew ? configure.newFlags : configure.chooseFlags
	if (gcpCollectLock(flags, capability, metricsIn(env.status)) !== null) return { model }
	const flag = CAPABILITIES[capability].flag
	const next = { ...flags, [flag]: !flags[flag] }
	return {
		model: withConfigure(model, () =>
			isNew ? { newFlags: next, createError: null } : { chooseFlags: next },
		),
	}
}

/** A connection's switch: its data step opens with the flip drafted, so saving goes the usual way. */
export const toggledFeature = (model: Card, env: Env, id: string, capability: Capability): Return =>
	steps(model, [
		(next) => openConfigure(next, env, { _tag: "Connection", id, stage: "choose" }),
		(next) => toggledCollect(next, env, capability),
	])

/** A filter changed after the setup was read (the flow's Back): the script is asked for again. */
const withFilter = (
	model: Card,
	env: Env,
	patch: (filter: LogFilterDraft) => Partial<LogFilterDraft>,
): Return => {
	const next = withConfigure(model, (configure) => ({
		filter: { ...configure.filter, ...patch(configure.filter) },
	}))
	return next.configure?.opened == null ? { model: next } : requestScripts(next, env, "Load")
}

export const clickedLogFilter = (model: Card): Return => ({
	model: withConfigure(model, (configure) => ({ isFilterOpen: !configure.isFilterOpen })),
})

export const clickedForwardOutput = (model: Card, env: Env): Return =>
	withFilter(model, env, () => ({ runtimes: [] }))

export const clickedUseOpenTelemetry = (model: Card, env: Env): Return =>
	withFilter(model, env, () => ({ runtimes: null }))

/** A runtime's tick flipped in the draft (shared with `/lab/gcp`). */
export const runtimeToggled = (filter: LogFilterDraft, runtime: GcpLogRuntime): Partial<LogFilterDraft> => {
	const runtimes = filter.runtimes ?? []
	return {
		runtimes: runtimes.includes(runtime)
			? Arr.filter(runtimes, (entry) => entry !== runtime)
			: [...runtimes, runtime],
	}
}

export const toggledRuntime = (model: Card, env: Env, runtime: GcpLogRuntime): Return =>
	withFilter(model, env, (filter) => runtimeToggled(filter, runtime))

/** Keep or replace an existing sink's filter. */
export const gotFilterMode = (model: Card, env: Env, message: Select.Message): Return => {
	const configure = model.configure
	if (configure === null) return { model }
	const step = Select.update(configure.filterMode, message)
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		GcpMessage.GotGcpFilterModeMessage({ message: inner }),
	)
	const picked = step.outMessage?._tag === "ChangedValue" ? step.outMessage.value : null
	const next = withConfigure(model, () => ({ filterMode: step.model }))
	if (picked === null) return { model: next, commands }
	const filtered = withFilter(next, env, () => ({ keep: picked === "keep" }))
	return { ...filtered, commands: [...commands, ...(filtered.commands ?? [])] }
}

const confirmStep = (model: Card, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withConfigure(model, () => ({ confirm: step.model })),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		GcpMessage.GotGcpConfirmDialogMessage({ message }),
	),
})

export const gotConfirmDialog = (model: Card, message: Dialog.Message): Return => {
	const configure = model.configure
	if (configure === null || configure.isSaving) return { model }
	return confirmStep(model, Dialog.update(configure.confirm, message))
}

/** Sends only what changed: the API leaves an omitted capability as it is. */
export const confirmedSave = (model: Card, env: Env): Return => {
	const configure = model.configure
	const connector = configure === null ? undefined : shownConnector(env, configure)
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
		model: withConfigure(withCard(model, { pendingWrite: "update" }), () => ({ isSaving: true })),
		commands: [UpdateConnector({ opens: model.configureOpens, id: connector.id, payload, flags: draft })],
	}
}

/** Unchanged leads on; a change that acts in Maple at once asks first; any other saves. */
export const clickedChooseApply = (model: Card, env: Env): Return => {
	const configure = model.configure
	const connector = configure === null ? undefined : shownConnector(env, configure)
	if (configure === null || connector === undefined || configure.isSaving) return { model }
	const { changed, immediate } = chooseChanges(connector, configure.chooseFlags)
	if (changed.length === 0) return toMethod(model, true)
	if (immediate.length > 0) return confirmStep(model, Dialog.open(configure.confirm))
	return confirmedSave(model, env)
}

/** A failed save keeps the confirmation open for a retry; a saved one leads into the run step. */
export const completedUpdate = (
	model: Card,
	opens: number,
	flags: GcpFlags,
	failure: LoadFailure | null,
): Return => {
	const write = settleWrite(model, opens)
	if (failure === null && !write.isCurrent) return staleWrite(write.model, true)
	const settled = write.isCurrent
		? withConfigure(write.model, () => ({ isSaving: false }))
		: staleWrite(write.model, false).model
	if (failure !== null)
		return {
			model: settled,
			requests: [HubRequest.toast("error", "Couldn't save the change", failure.message)],
		}
	// The data step unmounts with its confirmation, so that closes without a transition.
	const applied = withConfigure(settled, () => ({ asked: flags, confirm: initConfirm() }))
	return steps(applied, [(next) => toMethod(next, false), readStatus("Supersede"), refreshInventory])
}

/**
 * "Edit" or Back: from the Set up step the Method step again; from the Method step the data step,
 * its draft from the connection as shown.
 */
export const clickedRunEdit = (model: Card, env: Env): Return => {
	const configure = model.configure
	const connector = configure === null ? undefined : shownConnector(env, configure)
	if (configure === null || connector === undefined) return { model }
	if (configure.opened !== null)
		return {
			model: withConfigure(model, () => ({
				opened: null,
				connectionStage: "method",
				scripts: Keyed.idle(),
			})),
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
export const clickedMethod = (model: Card, method: SetupMethod): Return => ({
	model: withConfigure(model, (configure) => ({
		method,
		flavourGroup:
			method === "terraform" || method === "alchemy"
				? { ...configure.flavourGroup, values: [method] }
				: configure.flavourGroup,
	})),
})

export const gotFlavour = (model: Card, message: ToggleGroup.Message): Return => {
	const configure = model.configure
	if (configure === null) return { model }
	const step = ToggleGroup.update(configure.flavourGroup, message)
	const flavour = configure.method === "alchemy" ? "alchemy" : "terraform"
	const next = Arr.findFirst(FLAVOURS, (value) => value !== flavour && step.model.values.includes(value))
	return {
		model: withConfigure(model, () => ({
			flavourGroup: { ...step.model, values: [Option.getOrElse(next, () => flavour)] },
			method: Option.getOrElse(next, () => configure.method),
		})),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			GcpMessage.GotGcpFlavourMessage({ message: inner }),
		),
	}
}

const FLAVOURS = ["terraform", "alchemy"] as const

export const completedScripts = (
	model: Card,
	key: string,
	result: Parameters<typeof Keyed.accept<V2GcpSetupScripts, LoadFailure>>[2],
): Return => ({
	model: withConfigure(model, (configure) => ({ scripts: Keyed.accept(configure.scripts, key, result) })),
})

export const retriedScripts = (model: Card, env: Env): Return => requestScripts(model, env, "Refresh")

export const clickedScriptExpand = (model: Card): Return => ({
	model: withConfigure(model, (configure) => ({ isScriptExpanded: !configure.isScriptExpanded })),
})

/** A newer read that lists the connection replaces what was just saved (`asked.of === saved`). */
export const statusArrived = (model: Card, env: Env): Card => {
	const configure = model.configure
	const target = configure?.target
	const listed =
		target?._tag === "Connection" && Arr.some(connectorsIn(env.status), (entry) => entry.id === target.id)
	if (listed) return withConfigure(model, () => ({ asked: null }))
	// The flow starts with metrics on; a deployment without them turns the switch back off.
	return target?._tag === "New" && configure?.newFlags.metrics_enabled === true && !metricsIn(env.status)
		? withConfigure(model, () => ({ newFlags: { logs_enabled: true, metrics_enabled: false } }))
		: model
}

/** One console step open at a time; the open one closes on its own click. */
export const clickedManualStep = (model: Card, title: string, firstTitle: string | null): Return => ({
	model: withConfigure(model, (configure) => {
		const open = configure.isManualTouched ? configure.manualOpen : firstTitle
		return { manualOpen: open === title ? null : title, isManualTouched: true }
	}),
})

/** "Copy prompt for coding agent": the prompt takes the file's place, and the footer says if it copied. */
export const clickedCopyPrompt = (model: Card, prompt: string): Return => ({
	model: withConfigure(model, () => ({ isPromptShown: true, promptCopied: null })),
	commands: [CopyPrompt({ text: prompt })],
})

export const completedPromptCopy = (model: Card, isCopied: boolean): Return => ({
	model: withConfigure(model, () => ({ promptCopied: isCopied })),
})

export const clickedPromptBack = (model: Card): Return => ({
	model: withConfigure(model, () => ({ isPromptShown: false })),
})

/** "I've removed them": recorded on the admin's word, then the status read again. */
export const clickedConfirmRemoval = (model: Card, env: Env): Return => {
	const configure = model.configure
	const connector = configure === null ? undefined : shownConnector(env, configure)
	if (configure === null || connector === undefined || configure.isConfirmingRemoval) return { model }
	return {
		model: withConfigure(model, () => ({ isConfirmingRemoval: true })),
		commands: [ConfirmRemoval({ id: connector.id })],
	}
}

export const completedConfirmRemoval = (model: Card, failure: LoadFailure | null): Return => {
	const settled = withConfigure(model, () => ({ isConfirmingRemoval: false }))
	if (failure !== null)
		return {
			model: settled,
			requests: [HubRequest.toast("error", "Couldn't record the removal", failure.message)],
		}
	return steps(settled, [readStatus("Supersede"), refreshInventory])
}

/** The Set up step is open and Maple has not confirmed the run, or the first data. */
export const isAwaitingRun = (model: Card, slot: Env["status"], nowMs: number): boolean => {
	const configure = model.configure
	if (configure === null || configure.opened === null) return false
	const connector = configureConnector(connectorsIn(slot), configure)
	if (connector === undefined) return false
	if (configure.method === "script") return !runConfirmed(connector, configure.opened, nowMs)
	// Until each capability's first data, or its removal, is confirmed.
	return Arr.some(CAPABILITY_IDS, (capability) => {
		const applied =
			capability === "logs" ? connector.applied_logs_enabled : connector.applied_metrics_enabled
		return connector[CAPABILITIES[capability].flag] ? applied !== true : applied === true
	})
}
