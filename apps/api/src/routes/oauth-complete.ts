import {
	type ChatConnectorId,
	OAuthCompleteResponse,
	type OAuthCompleteRequest,
	type OAuthReturnFlow,
} from "@maple/domain/http"
import { Effect } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { OAuthFlowInitiator } from "@maple/backend/services/auth/oauth/oauth-state"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"
import { CloudflareAnalyticsService } from "@maple/backend/services/integrations/CloudflareAnalyticsService"
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import { SupabaseConnectionService } from "@maple/backend/services/integrations/SupabaseConnectionService"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"

const LABELS = {
	cloudflare: "Cloudflare",
	linear: "Linear",
	github: "GitHub",
	planetscale: "PlanetScale",
	supabase: "Supabase",
	chat_install: "Chat",
	chat_identity: "Chat",
} satisfies { readonly [K in OAuthReturnFlow]: string }

const CLOSE_HINT = "You can close this window and return to Maple."

/** A failure with display copy: our own sanitized strings, or generic text for the rest. */
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

/** The chat outcome's closed reason codes; a provider-authored string never reaches the page. */
const chatReason = (tag: string) => {
	switch (tag) {
		case "@maple/http/errors/IntegrationsValidationError":
			return "state"
		case "@maple/http/errors/IntegrationsForbiddenError":
			return "conflict"
		case "@maple/http/errors/IntegrationsNotFoundError":
			return "unknown"
		case "@maple/http/errors/IntegrationsConfigurationError":
			return "unconfigured"
		default:
			return "failed"
	}
}

const success = (message: string) => new OAuthCompleteResponse({ status: "success", message, chat: null })

/** Failed connects still answer 200 with display copy, so they are counted from these attributes. */
const annotateFailure = (tag: string) =>
	Effect.annotateCurrentSpan({ "maple.oauth.status": "error", "maple.oauth.error_tag": tag })

const failure = (message: string) => new OAuthCompleteResponse({ status: "error", message, chat: null })

/**
 * Finish a provider return for the signed-in caller. Every service redeems the state only for
 * `initiator`, so a callback query carried into another person's session completes nothing.
 */
export const makeOAuthCompleter = Effect.gen(function* () {
	const linear = yield* LinearOAuthService
	const github = yield* GithubConnectService
	const cloudflare = yield* CloudflareOAuthService
	const cloudflareAnalytics = yield* CloudflareAnalyticsService
	const planetscaleOAuth = yield* PlanetScaleOAuthService
	const planetscaleConnection = yield* PlanetScaleConnectionService
	const supabaseOAuth = yield* SupabaseOAuthService
	const supabaseConnection = yield* SupabaseConnectionService
	const chat = yield* ChatWorkspaceService

	/** The OAuth code flows: both parameters are required before anything is redeemed. */
	const withCode = <E extends { readonly _tag: string; readonly message: string }>(
		params: URLSearchParams,
		complete: (code: string, state: string) => Effect.Effect<OAuthCompleteResponse, E>,
	) => {
		const code = params.get("code")
		const state = params.get("state")
		return code === null || state === null || code === "" || state === ""
			? Effect.succeed(failure("Missing code or state in callback"))
			: complete(code, state)
	}

	const completeCloudflare = (code: string, state: string, initiator: OAuthFlowInitiator) =>
		cloudflare.completeConnect(code, state, initiator).pipe(
			// Rows a prior revoked-token error disabled have no other re-enable path. Clearing that
			// state must never fail the connect.
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
			Effect.as(success(CLOSE_HINT)),
		)

	// Single-org grants finish here; multi-org grants leave the org picker to the dashboard.
	const completePlanetScale = (code: string, state: string, initiator: OAuthFlowInitiator) =>
		planetscaleOAuth.completeConnect(code, state, initiator).pipe(
			Effect.flatMap((result) => {
				const [only, ...rest] = result.organizations
				return only !== undefined && rest.length === 0
					? planetscaleConnection
							.finalizeOrgSelection(result.orgId, { organization: only.name })
							.pipe(Effect.as(success(`Connected to ${only.name}. ${CLOSE_HINT}`)))
					: Effect.succeed(
							success(
								"Authorization complete. Choose which PlanetScale organization to connect back in Maple.",
							),
						)
			}),
		)

	const completeSupabase = (params: URLSearchParams, initiator: OAuthFlowInitiator) => {
		// RFC 9207 mix-up defense: Supabase names itself in `iss`; a different issuer is refused.
		const issuer = params.get("iss")
		if (issuer !== null && issuer.replace(/\/$/, "") !== supabaseOAuth.apiBaseUrl) {
			return Effect.succeed(
				failure("The authorization came from an unexpected issuer. Restart the connect flow."),
			)
		}
		return withCode(params, (code, state) =>
			supabaseOAuth
				.completeConnect(code, state, initiator)
				.pipe(
					Effect.flatMap((result) =>
						supabaseConnection
							.finalizeConnect(result.orgId, result.connectedByUserId, result.organization)
							.pipe(
								Effect.as(success(`Connected to ${result.organization.name}. ${CLOSE_HINT}`)),
							),
					),
				),
		)
	}

	const completeGithub = (params: URLSearchParams, initiator: OAuthFlowInitiator) => {
		const installationId = params.get("installation_id")
		const state = params.get("state")
		// Present only with OAuth-on-install enabled; proves the user owns the install.
		const code = params.get("code") ?? undefined
		if (installationId === null || installationId === "") {
			return Effect.succeed(
				failure(
					params.get("setup_action") === "request"
						? "Installation requested. An org admin must approve it on GitHub, then reconnect."
						: "Missing installation_id in callback",
				),
			)
		}
		if (state === null || state === "") {
			return Effect.succeed(
				failure(
					"Missing state in callback. GitHub did not return it. Restart the connection from the Maple dashboard.",
				),
			)
		}
		return github
			.completeConnect(installationId, state, code, initiator)
			.pipe(Effect.as(success(CLOSE_HINT)))
	}

	const completeChat = (
		kind: "workspace" | "identity",
		connector: ChatConnectorId | undefined,
		params: URLSearchParams,
		initiator: OAuthFlowInitiator,
	) => {
		const outcome = (name: string | null, reason: string | null) =>
			new OAuthCompleteResponse({
				status: reason === null ? "success" : "error",
				message: reason === null ? "Linked" : "Link failed",
				chat: { kind, name, reason },
			})
		if (connector === undefined) return Effect.succeed(outcome(null, "unknown"))
		const completed: Effect.Effect<
			string | null,
			Effect.Error<ReturnType<typeof chat.completeInstall>>
		> = kind === "workspace"
			? Effect.map(chat.completeInstall(connector, params, initiator), (result) => result.name)
			: Effect.map(
					chat.completeLink(connector, params, initiator),
					(result) => result.displayName ?? null,
				)
		return completed.pipe(
			Effect.tapError((error) =>
				annotateFailure(error._tag).pipe(
					Effect.andThen(
						Effect.logError("Chat OAuth completion failed", {
							connector,
							tag: error._tag,
							message: error.message,
						}),
					),
				),
			),
			Effect.map((name) => outcome(name, null)),
			Effect.catch((error) => Effect.succeed(outcome(null, chatReason(error._tag)))),
		)
	}

	return Effect.fn("OAuthComplete.complete")(function* (
		request: OAuthCompleteRequest,
		initiator: OAuthFlowInitiator,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: initiator.orgId, "maple.integration.flow": request.flow })
		const label = LABELS[request.flow]
		const params = new URLSearchParams(request.query)
		// A chat connector reads the whole query, its platform's error included.
		const oauthError = request.flow.startsWith("chat_") ? null : params.get("error")
		if (oauthError !== null) {
			yield* annotateFailure("provider_error")
			return failure(params.get("error_description") || oauthError || `${label} returned an error`)
		}
		const run = (() => {
			switch (request.flow) {
				case "cloudflare":
					return withCode(params, (code, state) => completeCloudflare(code, state, initiator))
				case "linear":
					return withCode(params, (code, state) =>
						linear.completeConnect(code, state, initiator).pipe(Effect.as(success(CLOSE_HINT))),
					)
				case "planetscale":
					return withCode(params, (code, state) => completePlanetScale(code, state, initiator))
				case "supabase":
					return completeSupabase(params, initiator)
				case "github":
					return completeGithub(params, initiator)
				case "chat_install":
					return completeChat("workspace", request.connector, params, initiator)
				case "chat_identity":
					return completeChat("identity", request.connector, params, initiator)
			}
		})()
		return yield* run.pipe(
			// The response reduces failures to short copy; the real cause stays in the log.
			Effect.tapError((error) =>
				annotateFailure(error._tag).pipe(
					Effect.andThen(
						Effect.logError(`${label} OAuth completeConnect failed`, {
							tag: error._tag,
							message: error.message,
						}),
					),
				),
			),
			Effect.catch((error) => Effect.succeed(failure(failureMessage(label, error)))),
		)
	})
})
