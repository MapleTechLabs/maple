// Google Cloud connector rules shared by the card and the hub: log forwarding state, the
// switch rules, and the add form's validation. Pure (no React, no atoms), like
// planetscale-setup-steps.ts.

import { Schema } from "effect"
import { V2GcpCreateConnectorRequest, type V2GcpConnector } from "@maple/domain/http/v2"
import { GcpProjectId, GcpResourceNumber, type GcpScopeType } from "@maple/domain/primitives"

export type GcpLogState =
	| { readonly kind: "off" }
	/** The setup script has not delivered a log yet. */
	| { readonly kind: "waiting" }
	| { readonly kind: "receiving"; readonly lastLogReceivedAt: string }
	/** Maple rejected the most recent push. Earlier pushes may have been accepted. */
	| { readonly kind: "error"; readonly error: string; readonly lastLogReceivedAt: string | null }

export function gcpLogState(
	connector: Pick<V2GcpConnector, "logs_enabled" | "last_log_received_at" | "last_log_error">,
): GcpLogState {
	if (!connector.logs_enabled) return { kind: "off" }
	if (connector.last_log_error !== null) {
		return {
			kind: "error",
			error: connector.last_log_error,
			lastLogReceivedAt: connector.last_log_received_at,
		}
	}
	if (connector.last_log_received_at === null) return { kind: "waiting" }
	return { kind: "receiving", lastLogReceivedAt: connector.last_log_received_at }
}

export type GcpFlags = Pick<V2GcpConnector, "logs_enabled" | "metrics_enabled">

/** Why a switch cannot be flipped: it is the last one on, or the deployment cannot read metrics. */
export type GcpSwitchLock = "last-on" | "metrics-unavailable"

/** The API refuses both of these, so the card disables the switch and says why. */
export function gcpSwitchLock(
	flags: GcpFlags,
	capability: "logs" | "metrics",
	metricsAvailable: boolean,
): GcpSwitchLock | null {
	const on = capability === "logs" ? flags.logs_enabled : flags.metrics_enabled
	const otherOn = capability === "logs" ? flags.metrics_enabled : flags.logs_enabled
	if (on) return otherOn ? null : "last-on"
	return capability === "metrics" && !metricsAvailable ? "metrics-unavailable" : null
}

export const GCP_SCOPE_NAMES = {
	project: "Project",
	folder: "Folder",
	organization: "Organization",
} as const

/** "Organization 123456789012", "Project acme-prod". */
export const gcpScopeLabel = (connector: Pick<V2GcpConnector, "scope_type" | "scope_id">): string =>
	`${GCP_SCOPE_NAMES[connector.scope_type]} ${connector.scope_id}`

/** What the add form holds. */
export interface GcpConnectorDraft {
	readonly scopeType: GcpScopeType
	/** A project ID, or the numeric ID of a folder or organization. */
	readonly scopeId: string
	/** Read only for a folder or organization; a project is its own host project. */
	readonly hostProjectId: string
}

const decodeCreateRequest = Schema.decodeUnknownOption(V2GcpCreateConnectorRequest)

/** The create request for a draft, decoded with the API's own schema; none while a field is wrong. */
export const gcpCreateRequest = (draft: GcpConnectorDraft) =>
	decodeCreateRequest(
		draft.scopeType === "project"
			? { scope_type: "project", scope_id: draft.scopeId.trim() }
			: {
					scope_type: draft.scopeType,
					scope_id: draft.scopeId.trim(),
					project_id: draft.hostProjectId.trim(),
				},
	)

export const isGcpProjectId = Schema.is(GcpProjectId)
export const isGcpResourceNumber = Schema.is(GcpResourceNumber)

/**
 * Opens the Google Cloud console on the host project with a Cloud Shell terminal attached. Cloud
 * Shell starts with the console's active project, and the scripts name the project on every
 * command, so a console that ignores the hint still runs them against the right one.
 */
export const cloudShellUrl = (projectId: string): string =>
	`https://console.cloud.google.com/?cloudshell=true&project=${encodeURIComponent(projectId)}`
