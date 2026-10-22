import {
	type ChatCallbackKind,
	type ChatCallbackReason,
	type ChatConnectorId,
	ChatCompleteResponse,
	type OAuthCallbackProvider,
	IntegrationReturnPath,
	OAuthCompleteResponse,
} from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import type { OAuthStateInitiator } from "@maple/backend/services/auth/oauth/state-initiator"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { HazelOAuthService } from "@maple/backend/services/auth/HazelOAuthService"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { CloudflareAnalyticsService } from "@maple/backend/services/integrations/CloudflareAnalyticsService"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import { SupabaseConnectionService } from "@maple/backend/services/integrations/SupabaseConnectionService"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

const LABELS = {
	hazel: "Hazel",
	github: "GitHub",
	cloudflare: "Cloudflare",
	planetscale: "PlanetScale",
	supabase: "Supabase",
} satisfies Record<OAuthCallbackProvider, string>

const decodeReturnPath = Schema.decodeUnknownOption(IntegrationReturnPath)

const CLOSE_MESSAGE = "You can close this window and return to Maple."

type Completed = { readonly returnTo: string | null; readonly message: string }

/** Shown copy for a failed completion. Validation and upstream messages are our own sanitized strings. */
const failureMessage = (label: string, error: { readonly _tag: string; readonly message: string }) => {
	switch (error._tag) {
		case "@maple/http/errors/IntegrationsConfigurationError":
			return `${label} integration is not configured in Maple`
		case "@maple/http/errors/IntegrationsValidationError":
		case "@maple/http/errors/IntegrationsUpstreamError":
			return error.message
		case "@maple/http/errors/IntegrationsNotConnectedError":
			return `${label} connection not found. Restart the connect flow.`
		case "@maple/http/errors/IntegrationsRevokedError":
			return `${label} rejected the authorization. Reconnect and try again.`
		default:
			return `Failed to complete the ${label} connection`
	}
}

const CHAT_REASONS = new Map<string, ChatCallbackReason>([
	["@maple/http/errors/IntegrationsValidationError", "state"],
	["@maple/http/errors/IntegrationsForbiddenError", "conflict"],
	["@maple/http/errors/IntegrationsNotFoundError", "unknown"],
	["@maple/http/errors/IntegrationsConfigurationError", "unconfigured"],
])

/**
 * Finishing a connect, install or account link the public callback forwarded to the dashboard.
 * Every service redeems the state row only for `initiator`, the signed-in session calling here.
 */
export const makeIntegrationCompleter = Effect.gen(function* () {
	const hazel = yield* HazelOAuthService
	const github = yield* GithubConnectService
	const cloudflare = yield* CloudflareOAuthService
	const cloudflareAnalytics = yield* CloudflareAnalyticsService
	const planetscaleOAuth = yield* PlanetScaleOAuthService
	const planetscaleConnection = yield* PlanetScaleConnectionService
	const supabaseOAuth = yield* SupabaseOAuthService
	const supabaseConnection = yield* SupabaseConnectionService
	const chat = yield* ChatWorkspaceService
	// RFC 9207 mix-up defense: Supabase names itself in `iss`; a different issuer is refused.
	const supabaseIssuer = supabaseOAuth.apiBaseUrl

	const complete = (
		initiator: OAuthStateInitiator,
		provider: OAuthCallbackProvider,
		code: string,
		state: string,
		params: URLSearchParams,
	) => {
		switch (provider) {
			case "hazel":
				return hazel.completeConnect(initiator, code, state).pipe(
					Effect.map((result): Completed => ({
						returnTo: result.returnTo,
						message: CLOSE_MESSAGE,
					})),
				)
			case "cloudflare":
				return cloudflare.completeConnect(initiator, code, state).pipe(
					// Reconnect writes fresh tokens, but rows a prior revoked-token error disabled have no
					// other re-enable path for the account-scoped workers anchor row. Never fails the flow.
					Effect.tap((result) =>
						cloudflareAnalytics.resetOrgState(result.orgId).pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning("cloudflare post-connect state reset failed", {
									orgId: result.orgId,
									error: summarizeCause(cause),
								}),
							),
						),
					),
					// The prime poll runs from the dashboard (`cloudflarePrime`), never here.
					Effect.map((result): Completed => ({
						returnTo: result.returnTo,
						message: CLOSE_MESSAGE,
					})),
				)
			case "planetscale":
				return planetscaleOAuth.completeConnect(initiator, code, state).pipe(
					// Single-org grants finish here (bind + provision the scrape target); multi-org grants
					// leave the org picker to the dashboard.
					Effect.flatMap((result) => {
						const only = result.organizations.length === 1 ? result.organizations[0] : undefined
						return only === undefined
							? Effect.succeed<Completed>({
									returnTo: result.returnTo,
									message:
										"Authorization complete. Choose which PlanetScale organization to connect back in Maple.",
								})
							: planetscaleConnection
									.finalizeOrgSelection(result.orgId, { organization: only.name })
									.pipe(
										Effect.as<Completed>({
											returnTo: result.returnTo,
											message: `Connected to ${only.name}. ${CLOSE_MESSAGE}`,
										}),
									)
					}),
				)
			case "supabase": {
				const issuer = params.get("iss")
				if (issuer !== null && issuer.replace(/\/$/, "") !== supabaseIssuer) {
					return Effect.succeed(
						new OAuthCompleteResponse({
							status: "error",
							message:
								"The authorization came from an unexpected issuer. Restart the connect flow.",
							returnTo: null,
						}),
					)
				}
				// One grant is one Supabase organization: bind it and return.
				return supabaseOAuth.completeConnect(initiator, code, state).pipe(
					Effect.flatMap((result) =>
						supabaseConnection
							.finalizeConnect(result.orgId, result.connectedByUserId, result.organization)
							.pipe(
								Effect.as<Completed>({
									returnTo: result.returnTo,
									message: `Connected to ${result.organization.name}. ${CLOSE_MESSAGE}`,
								}),
							),
					),
				)
			}
			case "github": {
				// `code` is present only with OAuth-on-install enabled; it proves the user owns the install.
				const installationId = params.get("installation_id") ?? ""
				return github
					.completeConnect(initiator, installationId, state, code === "" ? undefined : code)
					.pipe(
						Effect.map((result): Completed => ({
							returnTo: result.returnTo,
							message: CLOSE_MESSAGE,
						})),
					)
			}
		}
	}

	const completeOAuth = Effect.fn("IntegrationCompleter.oauth")(function* (
		initiator: OAuthStateInitiator,
		provider: OAuthCallbackProvider,
		query: string,
	) {
		yield* Effect.annotateCurrentSpan({ "maple.integration.provider": provider })
		const label = LABELS[provider]
		const params = new URLSearchParams(query)
		const failed = (message: string) =>
			new OAuthCompleteResponse({ status: "error", message, returnTo: null })

		const oauthError = params.get("error")
		if (oauthError !== null) {
			return failed(params.get("error_description") || `${label} returned an error`)
		}
		const state = params.get("state")
		if (provider === "github") {
			// `setup_action=request`: the org requires admin approval, so there is no installation yet.
			if (params.get("installation_id") === null) {
				return failed(
					params.get("setup_action") === "request"
						? "Installation requested — an org admin must approve it on GitHub, then reconnect."
						: "Missing installation_id in callback",
				)
			}
			if (state === null) {
				return failed(
					"Missing state in callback — GitHub did not return it. Restart the connection from the Maple dashboard.",
				)
			}
		}
		const code = params.get("code") ?? ""
		if (state === null || (provider !== "github" && code === "")) {
			return failed("Missing code or state in callback")
		}

		return yield* complete(initiator, provider, code, state, params).pipe(
			Effect.map((result) =>
				result instanceof OAuthCompleteResponse
					? result
					: new OAuthCompleteResponse({
							status: "success",
							message: result.message,
							returnTo: Option.getOrNull(decodeReturnPath(result.returnTo)),
						}),
			),
			// The response reduces failures to short copy; the real cause still goes to the log.
			Effect.catch((error) =>
				Effect.logError(`${label} OAuth completeConnect failed`, {
					tag: error._tag,
					message: error.message,
				}).pipe(Effect.as(failed(failureMessage(label, error)))),
			),
		)
	})

	const completeChat = Effect.fn("IntegrationCompleter.chat")(function* (
		initiator: OAuthStateInitiator,
		connector: ChatConnectorId,
		kind: ChatCallbackKind,
		query: string,
	) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.connector": connector, "maple.chat.callback": kind })
		const params = new URLSearchParams(query)
		const completed =
			kind === "install"
				? chat
						.completeInstall(initiator, connector, params)
						.pipe(Effect.map((result): string | null => result.name))
				: chat
						.completeLink(initiator, connector, params)
						.pipe(Effect.map((result) => result.displayName ?? null))
		return yield* completed.pipe(
			Effect.map((name) => new ChatCompleteResponse({ status: "success", reason: null, name })),
			Effect.catch((error) =>
				Effect.logError(
					kind === "install" ? "Chat install callback failed" : "Chat account link callback failed",
					{ connector, tag: error._tag, message: error.message },
				).pipe(
					Effect.as(
						new ChatCompleteResponse({
							status: "error",
							reason: CHAT_REASONS.get(error._tag) ?? "failed",
							name: null,
						}),
					),
				),
			),
		)
	})

	return { completeOAuth, completeChat } as const
})
