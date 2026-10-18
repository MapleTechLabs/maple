import type { V2GcpConnector, V2GcpSetupScripts } from "@maple/domain/http/v2"
import type { GcpLogRuntime } from "@maple/domain/primitives"
import {
	gcpCollectLock,
	gcpLogFilterChoice,
	gcpScriptNeeded,
} from "@maple/web/components/integrations/gcp-connector-state"
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
	CreateConnector,
	flagsOf,
	initConfigure,
	initConfirm,
	LoadConfigureScripts,
	UpdateConnector,
} from "./gcp-configure"
import { CAPABILITIES, SCOPE_TYPES } from "./gcp-configure-copy"
import { chooseChanges, createRequest, isScopeReady } from "./gcp-configure-derive"
import type { Capability, ConfigureModel, GcpFlags, LogFilterDraft } from "./gcp-configure-schema"
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
export const scriptsKey = (context: PageContext, connector: V2GcpConnector, filter: LogFilterDraft) => {
	const applicationLogs =
		gcpLogFilterChoice(filter, connector.applied_logs_enabled === true).applicationLogs ?? null
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
	const { key, applicationLogs } = scriptsKey(context, connector, configure.filter)
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
	return requestScripts(
		withConfigure(model, () => ({ opened, scripts: Keyed.idle(), isScriptExpanded: false })),
		context,
		"Load",
	)
}

export const openConfigure = (model: Model, context: PageContext, target: ConfigureTarget): Return => {
	const configure = initConfigure(target, gcpConnectors(model), metricsAvailable(model))
	const shown = dialogStep(updateGcpCard(model, { configure }).model, Dialog.open(configure.dialog))
	const saved = savedConnector(shown.model, configure)
	if (target._tag === "New" || target.stage === "choose" || saved === undefined) return shown
	// Found waiting on a first run, the status times it from the connection's creation.
	return chain(shown.model, [
		() => shown,
		(next) => enterApply(next, context, gcpScriptNeeded(saved, model.nowMs) !== "setup-pending"),
	])
}

export const closedConfigure = (model: Model): Return => updateGcpCard(model, { configure: null })

/** The X and Escape close the wizard outright, as legacy's `onOpenChange(false)`. */
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
			model: withConfigure(model, () => ({ isCreating: true, createError: null })),
			commands: [CreateConnector({ request })],
		}),
	})
}

/** A refused scope keeps its message on screen; a created one leads into the run step. */
export const completedCreate = (
	model: Model,
	context: PageContext,
	connector: V2GcpConnector | null,
	failure: LoadFailure | null,
): Return => {
	const settled = withConfigure(model, () => ({ isCreating: false }))
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
			(next) => enterApply(next, context, false),
			(next) => requestStatus(next, context, "gcp", "Refresh"),
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

export const toggledRuntime = (model: Model, runtime: GcpLogRuntime): Return =>
	withFilter(model, (filter) => {
		const runtimes = filter.runtimes ?? []
		return {
			runtimes: runtimes.includes(runtime)
				? runtimes.filter((entry) => entry !== runtime)
				: [...runtimes, runtime],
		}
	})

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
		model: withConfigure(model, () => ({ isSaving: true })),
		commands: [UpdateConnector({ id: connector.id, payload, flags: draft })],
	}
}

/** Unchanged leads on; a change that acts in Maple at once asks first; any other saves. */
export const clickedChooseApply = (model: Model, context: PageContext): Return => {
	const configure = model.gcpCard.configure
	const connector = configure === null ? undefined : configureConnector(model, configure)
	if (configure === null || connector === undefined || configure.isSaving) return { model }
	const { changed, immediate } = chooseChanges(connector, configure.chooseFlags)
	if (changed.length === 0) return enterApply(model, context, true)
	if (immediate.length > 0) return confirmStep(model, Dialog.open(configure.confirm))
	return save(model)
}

export const confirmedSave = save

/** A failed save keeps the confirmation open for a retry; a saved one leads into the run step. */
export const completedUpdate = (
	model: Model,
	context: PageContext,
	flags: GcpFlags,
	failure: LoadFailure | null,
): Return => {
	const settled = withConfigure(model, () => ({ isSaving: false }))
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
		(next) => enterApply(next, context, false),
		(next) => requestStatus(next, context, "gcp", "Refresh"),
		refreshInventory,
	])
}

/** "Edit" in the run step: the data step again, its draft from the connection as shown. */
export const clickedRunEdit = (model: Model): Return => {
	const configure = model.gcpCard.configure
	const connector = configure === null ? undefined : configureConnector(model, configure)
	if (configure === null || connector === undefined) return { model }
	return {
		model: withConfigure(model, () => ({
			opened: null,
			chooseFlags: flagsOf(connector),
			scripts: Keyed.idle(),
			confirm: initConfirm(),
		})),
	}
}

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
