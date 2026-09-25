/**
 * The rollout-flag contract lives in `@maple/domain` so the backend decodes the same Clerk
 * metadata the web app does; re-exported here so existing imports stay put.
 */
import { chatConnectorManifests } from "@maple/chat-platform/manifests"

export * from "@maple/domain/organization-feature-flags"

/**
 * Whether a chat connector's integration is offered to this organization: every
 * org once its manifest is `released`, otherwise from the `<connector id>_bot` key in the same public metadata — derived from
 * the id, so a new connector needs no code here and names itself nowhere else.
 *
 * Who is shown the door, not who may walk through it: the API is unchanged.
 * Truthy rather than the literal `true` the rollout flags demand, because this
 * key is typed by hand in the Clerk dashboard.
 */
export function isChatConnectorEnabled(metadata: unknown, connectorId: string): boolean {
	if (chatConnectorManifests.some((manifest) => manifest.id === connectorId && manifest.released)) return true
	if (typeof metadata !== "object" || metadata === null) return false
	return Boolean((metadata as Record<string, unknown>)[`${connectorId}_bot`])
}
