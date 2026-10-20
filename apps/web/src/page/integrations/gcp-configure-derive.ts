import type { V2GcpConnector } from "@maple/domain/http/v2"
import {
	gcpCreateRequest,
	gcpDraftEffect,
	gcpScriptNeeded,
	gcpSetupRunning,
	isGcpProjectId,
	isGcpResourceNumber,
} from "../../components/integrations/gcp-connector-state"
import { CAPABILITIES, CAPABILITY_IDS } from "./gcp-configure-copy"
import type { ApplyOpened, Capability, ConfigureModel, GcpFlags } from "./gcp-configure-schema"

// `GcpConfigure`'s pure rules: the scope step's readiness, what a save changes and when.

export const newDraft = (configure: ConfigureModel) => ({
	scopeType: configure.scopeType,
	scopeId: configure.scopeId.value,
	hostProjectId: configure.hostProjectId.value,
	logsEnabled: configure.newFlags.logs_enabled,
	metricsEnabled: configure.newFlags.metrics_enabled,
})

/** Decoded with the API's own schema, so a rejected ID is caught before the request. */
export const createRequest = (configure: ConfigureModel) => gcpCreateRequest(newDraft(configure))

export const isScopeReady = (configure: ConfigureModel): boolean => {
	const scopeId = configure.scopeId.value.trim()
	return configure.scopeType === "project"
		? isGcpProjectId(scopeId)
		: isGcpResourceNumber(scopeId) && isGcpProjectId(configure.hostProjectId.value.trim())
}

type Acting = Readonly<{ capability: Capability; acts: "stops-now" | "resumes-now" }>

/** `ChooseStage`: what changed, what acts in Maple when saved, and whether a script run follows. */
export const chooseChanges = (connector: V2GcpConnector, draft: GcpFlags) => {
	const changed = CAPABILITY_IDS.filter(
		(capability) => draft[CAPABILITIES[capability].flag] !== connector[CAPABILITIES[capability].flag],
	)
	const effect = (capability: Capability) =>
		gcpDraftEffect(connector, capability, draft[CAPABILITIES[capability].flag])
	const immediate: ReadonlyArray<Acting> = CAPABILITY_IDS.flatMap((capability) => {
		const acts = effect(capability)
		return acts === "stops-now" || acts === "resumes-now" ? [{ capability, acts }] : []
	})
	const scripted = CAPABILITY_IDS.some((capability) => {
		const acts = effect(capability)
		return acts !== null && acts !== "resumes-now"
	})
	return {
		changed,
		effect,
		immediate,
		stopping: immediate.filter(({ acts }) => acts === "stops-now"),
		resuming: immediate.filter(({ acts }) => acts === "resumes-now"),
		scripted,
	}
}

/** A run's sections report one after the other: confirmed once the last one has. */
export const runConfirmed = (connector: V2GcpConnector, opened: ApplyOpened, nowMs: number): boolean =>
	gcpScriptNeeded(connector, nowMs) === null &&
	!gcpSetupRunning(connector, nowMs) &&
	(!opened.rerun || connector.setup_reported_at !== opened.seen)
