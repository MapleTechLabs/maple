import type { V2GcpConnector } from "@maple/domain/http/v2"
import {
	GCP_SCOPE_NAMES,
	gcpConnectionState,
	gcpScopeLabel,
	gcpScriptOverdue,
	isGcpProjectId,
	isGcpResourceNumber,
} from "../../components/integrations/gcp-connector-state"
import type { FlowSpec, LiveHealth } from "./flow"
import { isScopeReady, runConfirmed } from "./gcp-configure-derive"
import type { ConfigureModel } from "./gcp-configure-schema"
import type { Model } from "./model"
import { configureConnector } from "./update-gcp-configure"

// Google Cloud's place in the connect flow: a scope by ID, what to collect, then the setup in
// Google Cloud. The connection is created at the end of Choose data, so Go live has its setup.

/** The connection this visit created, as last saved. */
export const flowConnector = (model: Model): V2GcpConnector | null => {
	const configure = model.gcpCard.configure
	return configure === null || configure.target._tag === "New"
		? null
		: (configureConnector(model, configure) ?? null)
}

/** What a connection collects, in a few words: "Logs + metrics". */
export const collectsLabel = (flags: Pick<V2GcpConnector, "logs_enabled" | "metrics_enabled">): string =>
	flags.logs_enabled && flags.metrics_enabled
		? "Logs + metrics"
		: flags.logs_enabled
			? "Logs only"
			: "Metrics only"

export type ScopeCheck = "empty" | "bad-id" | "bad-host" | "ready"

/** What the typed IDs say before anything is sent: the only check there is without a sign-in. */
export const scopeCheck = (configure: ConfigureModel): ScopeCheck => {
	const scopeId = configure.scopeId.value.trim()
	if (isScopeReady(configure)) return "ready"
	if (scopeId === "") return "empty"
	const idValid = configure.scopeType === "project" ? isGcpProjectId(scopeId) : isGcpResourceNumber(scopeId)
	return idValid ? "bad-host" : "bad-id"
}

const liveOf = (model: Model, configure: ConfigureModel, connector: V2GcpConnector): LiveHealth => {
	const state = gcpConnectionState(connector, model.nowMs)
	if (state === "attention") return "attention"
	if (state === "healthy") return "healthy"
	const opened = configure.opened
	const overdue =
		opened !== null &&
		configure.method === "script" &&
		!runConfirmed(connector, opened, model.nowMs) &&
		gcpScriptOverdue(connector, opened.at, model.nowMs)
	return overdue ? "attention" : "pending"
}

export const gcpFlow = (model: Model): FlowSpec => {
	const configure = model.gcpCard.configure
	const connector = flowConnector(model)
	const check = configure === null ? "empty" : scopeCheck(configure)
	const connected =
		connector !== null
			? gcpScopeLabel(connector)
			: configure !== null && check === "ready"
				? `${GCP_SCOPE_NAMES[configure.scopeType]} ${configure.scopeId.value.trim()}`
				: null
	const live = configure === null || connector === null ? "pending" : liveOf(model, configure, connector)
	return {
		stages: ["connect", "choose", "live"],
		connected,
		chosen: connector === null ? null : collectsLabel(connector),
		live,
		hint: {
			connect:
				connected !== null
					? "Looks right. Next, choose what to collect."
					: check === "bad-host"
						? "Enter a valid host project ID to continue."
						: check === "bad-id"
							? "Fix the ID to continue."
							: "Enter an ID to continue.",
			choose:
				configure?.isCreating === true
					? "Creating the connection."
					: connector === null
						? "Create the connection to continue."
						: "Saved. Next, apply the setup in Google Cloud.",
			live:
				live === "healthy"
					? "Live. Data keeps arriving on its own."
					: live === "attention"
						? "Saved. Fix what the checklist names; nothing is lost."
						: "Saved. Leave any time; progress shows on the source page.",
		},
	}
}
