// A Google Cloud connector's log forwarding state, derived from the two fields the status
// endpoint returns. Pure (no React, no atoms), like planetscale-setup-steps.ts.

import type { V2GcpConnector } from "@maple/domain/http/v2"

type ConnectorLogFields = Pick<V2GcpConnector, "last_log_received_at" | "last_log_error">

export type GcpLogState =
	/** The setup script has not delivered a log yet. */
	| { readonly kind: "waiting" }
	| { readonly kind: "receiving"; readonly lastLogReceivedAt: string }
	/** Maple rejected the most recent push. Earlier pushes may have been accepted. */
	| { readonly kind: "error"; readonly error: string; readonly lastLogReceivedAt: string | null }

export function gcpLogState(connector: ConnectorLogFields): GcpLogState {
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

/**
 * Opens the Google Cloud console on the project with a Cloud Shell terminal attached. Cloud Shell
 * starts with the console's active project, and the scripts pass `--project` on every command, so
 * a console that ignores the hint still runs them against the right project.
 */
export const cloudShellUrl = (projectId: string): string =>
	`https://console.cloud.google.com/?cloudshell=true&project=${encodeURIComponent(projectId)}`
