import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	DeleteServiceRepoResponse,
	GithubDisconnectResponse,
	GithubIntegrationStatus,
	GithubReposListResponse,
	GithubStartConnectResponse,
	HazelChannelsListResponse,
	HazelDisconnectResponse,
	HazelIntegrationStatus,
	HazelOrganizationsListResponse,
	HazelStartConnectResponse,
	IntegrationsForbiddenError,
	IntegrationsValidationError,
	MapleApi,
	ServiceRepoMapping,
	ServiceRepoMappingsResponse,
} from "@maple/domain/http"
import { Effect } from "effect"
import { GitHubOAuthService } from "../services/GitHubOAuthService"
import { HazelOAuthService } from "../services/HazelOAuthService"

const HAZEL_CALLBACK_PATH = "/api/integrations/hazel/callback"
const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback"

const resolveRequestOrigin = (req: HttpServerRequest.HttpServerRequest): string => {
	const headers = req.headers as Record<string, string | undefined>
	const forwardedHost = headers["x-forwarded-host"]
	const forwardedProto = headers["x-forwarded-proto"]
	const host = forwardedHost ?? headers.host
	if (host) {
		const proto =
			forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
		return `${proto}://${host}`
	}
	// Fall back to parsing req.url which is absolute under wrangler/CF Workers.
	try {
		const parsed = new URL(req.url)
		return `${parsed.protocol}//${parsed.host}`
	} catch {
		return ""
	}
}

const resolveCallbackUrl = (req: HttpServerRequest.HttpServerRequest, path: string): string =>
	`${resolveRequestOrigin(req)}${path}`

const ADMIN_ROLES = new Set(["root", "org:admin"])

const requireAdmin = (roles: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		if (roles.some((role) => ADMIN_ROLES.has(role))) return
		yield* Effect.fail(
			new IntegrationsForbiddenError({
				message: "Only org admins can manage integrations",
			}),
		)
	})

export const HttpIntegrationsLive = HttpApiBuilder.group(MapleApi, "integrations", (handlers) =>
	Effect.gen(function* () {
		const hazel = yield* HazelOAuthService
		const github = yield* GitHubOAuthService

		return handlers
			.handle("hazelStatus", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* hazel.getStatus(tenant.orgId)
					if (!status.connected) {
						return new HazelIntegrationStatus({
							connected: false,
							externalUserId: null,
							externalUserEmail: null,
							connectedByUserId: null,
							scope: null,
						})
					}
					return new HazelIntegrationStatus({
						connected: true,
						externalUserId: status.externalUserId,
						externalUserEmail: status.externalUserEmail,
						connectedByUserId: status.connectedByUserId,
						scope: status.scope,
					})
				}),
			)
			.handle("hazelStart", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const req = yield* HttpServerRequest.HttpServerRequest
					const result = yield* hazel.startConnect(tenant.orgId, tenant.userId, {
						callbackUrl: resolveCallbackUrl(req, HAZEL_CALLBACK_PATH),
						returnTo: payload.returnTo,
					})
					return new HazelStartConnectResponse(result)
				}),
			)
			.handle("hazelOrganizations", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const organizations = yield* hazel.listOrganizations(tenant.orgId)
					return new HazelOrganizationsListResponse({
						organizations: organizations.map((o) => ({
							id: o.id,
							name: o.name,
							slug: o.slug,
							logoUrl: o.logoUrl,
						})),
					})
				}),
			)
			.handle("hazelChannels", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const channels = yield* hazel.listChannels(tenant.orgId, params.organizationId)
					return new HazelChannelsListResponse({
						channels: channels.map((c) => ({
							id: c.id,
							name: c.name,
							type: c.type,
							organizationId: c.organizationId,
						})),
					})
				}),
			)
			.handle("hazelDisconnect", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const result = yield* hazel.disconnect(tenant.orgId)
					return new HazelDisconnectResponse(result)
				}),
			)
			.handle("githubStatus", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* github.getStatus(tenant.orgId)
					if (!status.connected) {
						return new GithubIntegrationStatus({
							connected: false,
							externalUserId: null,
							externalUserLogin: null,
							connectedByUserId: null,
							scope: null,
						})
					}
					return new GithubIntegrationStatus({
						connected: true,
						externalUserId: status.externalUserId,
						externalUserLogin: status.externalUserLogin,
						connectedByUserId: status.connectedByUserId,
						scope: status.scope,
					})
				}),
			)
			.handle("githubStart", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const req = yield* HttpServerRequest.HttpServerRequest
					const result = yield* github.startConnect(tenant.orgId, tenant.userId, {
						callbackUrl: resolveCallbackUrl(req, GITHUB_CALLBACK_PATH),
						returnTo: payload.returnTo,
					})
					return new GithubStartConnectResponse(result)
				}),
			)
			.handle("githubRepos", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const repos = yield* github.listRepos(tenant.orgId)
					return new GithubReposListResponse({
						repos: repos.map((r) => ({
							owner: r.owner,
							name: r.name,
							fullName: r.fullName,
							private: r.private,
						})),
					})
				}),
			)
			.handle("githubServiceRepos", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const mappings = yield* github.listServiceRepos(tenant.orgId)
					return new ServiceRepoMappingsResponse({
						mappings: mappings.map((m) => new ServiceRepoMapping(m)),
					})
				}),
			)
			.handle("githubSetServiceRepo", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const mapping = yield* github.setServiceRepo(tenant.orgId, tenant.userId, {
						serviceName: payload.serviceName,
						repoOwner: payload.repoOwner,
						repoName: payload.repoName,
					})
					return new ServiceRepoMapping(mapping)
				}),
			)
			.handle("githubDeleteServiceRepo", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const result = yield* github.deleteServiceRepo(tenant.orgId, params.serviceName)
					return new DeleteServiceRepoResponse(result)
				}),
			)
			.handle("githubDisconnect", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const result = yield* github.disconnect(tenant.orgId)
					return new GithubDisconnectResponse(result)
				}),
			)
	}),
)

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")

// JSON.stringify does not escape `<` or `>`, so a payload value of
// `</script><script>alert(1)</script>` would terminate the inline script
// block. Escape these characters and the U+2028 / U+2029 line separators
// (which are valid line terminators in JS but not in JSON) before
// interpolating into a `<script>` body.
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const escapeJsonInHtml = (json: string) =>
	json
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.split(LINE_SEPARATOR)
		.join("\\u2028")
		.split(PARAGRAPH_SEPARATOR)
		.join("\\u2029")

const renderCallbackPage = (params: {
	provider: { key: string; label: string }
	status: "success" | "error"
	message: string
	returnTo: string | null
}) => {
	const safeMessage = escapeHtml(params.message)
	const safeReturn = params.returnTo ? escapeHtml(params.returnTo) : null
	const safeLabel = escapeHtml(params.provider.label)
	const payload = escapeJsonInHtml(
		JSON.stringify({
			type: `maple:integration:${params.provider.key}`,
			status: params.status,
			message: params.message,
		}),
	)
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Maple — ${safeLabel} integration</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem; max-width: 28rem; margin: 0 auto; color: #111; }
      .ok { color: #047857; }
      .err { color: #b91c1c; }
      a.button { display: inline-block; margin-top: 1rem; background: #111; color: white; padding: 0.5rem 1rem; border-radius: 0.5rem; text-decoration: none; }
    </style>
  </head>
  <body>
    <h1 class="${params.status === "success" ? "ok" : "err"}">
      ${params.status === "success" ? `${safeLabel} connected` : `${safeLabel} connection failed`}
    </h1>
    <p>${safeMessage}</p>
    ${safeReturn ? `<p><a class="button" href="${safeReturn}">Return to Maple</a></p>` : ""}
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, "*");
          setTimeout(function () { window.close(); }, 600);
        }
      } catch (_) {}
    </script>
  </body>
</html>`
}

const htmlResponse = (body: string, status?: number) => {
	const response = HttpServerResponse.html(body)
	return status === undefined ? response : HttpServerResponse.setStatus(response, status)
}

type CompleteConnect = (
	code: string,
	state: string,
) => Effect.Effect<{ readonly returnTo: string | null }, { readonly message: string }>

const makeCallbackHandler =
	(provider: { key: string; label: string }, completeConnect: CompleteConnect) =>
	(req: HttpServerRequest.HttpServerRequest) =>
		Effect.gen(function* () {
			const url = new URL(req.url, "http://localhost")
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")
			const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

			if (oauthError) {
				return htmlResponse(
					renderCallbackPage({
						provider,
						status: "error",
						message: oauthErrorDescription || `${provider.label} returned an error`,
						returnTo: null,
					}),
					400,
				)
			}

			if (!code || !state) {
				return htmlResponse(
					renderCallbackPage({
						provider,
						status: "error",
						message: "Missing code or state in callback",
						returnTo: null,
					}),
					400,
				)
			}

			return yield* completeConnect(code, state).pipe(
				Effect.match({
					onFailure: (error) =>
						htmlResponse(
							renderCallbackPage({
								provider,
								status: "error",
								message:
									error instanceof IntegrationsValidationError
										? error.message
										: `Failed to complete ${provider.label} connection`,
								returnTo: null,
							}),
							400,
						),
					onSuccess: (result) =>
						htmlResponse(
							renderCallbackPage({
								provider,
								status: "success",
								message: "You can close this window and return to Maple.",
								returnTo: result.returnTo,
							}),
						),
				}),
			)
		})

export const IntegrationsCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const hazel = yield* HazelOAuthService
		const github = yield* GitHubOAuthService

		yield* router.add(
			"GET",
			HAZEL_CALLBACK_PATH,
			makeCallbackHandler({ key: "hazel", label: "Hazel" }, hazel.completeConnect),
		)
		yield* router.add(
			"GET",
			GITHUB_CALLBACK_PATH,
			makeCallbackHandler({ key: "github", label: "GitHub" }, github.completeConnect),
		)
	}),
)
