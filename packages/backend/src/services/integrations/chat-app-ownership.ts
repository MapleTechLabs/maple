/**
 * Whether this deployment may end a chat grant at the platform.
 *
 * A PR preview or a local stack can hold the credentials of the chat app production runs, and a
 * revoke sent from there would take the production bot out of the workspace. Only a deployment
 * known to own its chat app revokes; an environment this does not recognise does not.
 */
export type ChatAppRevokeDecision =
	| { readonly revoke: true }
	| {
			readonly revoke: false
			readonly reason: "preview_deployment" | "development_deployment" | "unknown_deployment"
	  }

/** `environment` is `MAPLE_ENVIRONMENT`: `production`, `pr-<n>` or `development`. */
export const chatAppRevokeDecision = (environment: string): ChatAppRevokeDecision => {
	if (environment === "production") return { revoke: true }
	if (/^pr-\d+$/.test(environment)) return { revoke: false, reason: "preview_deployment" }
	if (environment === "development") return { revoke: false, reason: "development_deployment" }
	return { revoke: false, reason: "unknown_deployment" }
}
