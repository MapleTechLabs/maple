import { assert, describe, it } from "@effect/vitest"
import {
	IntegrationsForbiddenError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	PlanetScaleIntegrationStatus,
	SupabaseIntegrationStatus,
	UserId,
} from "@maple/domain/http"
import { ChatConnectorId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { HazelOAuthService } from "@maple/backend/services/auth/HazelOAuthService"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import type { OAuthStateInitiator } from "@maple/backend/services/auth/oauth/state-initiator"
import { CloudflareAnalyticsService } from "@maple/backend/services/integrations/CloudflareAnalyticsService"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import { SupabaseConnectionService } from "@maple/backend/services/integrations/SupabaseConnectionService"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"
import { makeIntegrationCompleter } from "./integrations-complete"

const ORG = Schema.decodeSync(OrgId)("org_session")
const SESSION: OAuthStateInitiator = { orgId: ORG, userId: Schema.decodeSync(UserId)("user_session") }
const SLACK = Schema.decodeSync(ChatConnectorId)("slack")
const SUPABASE_API = "https://api.supabase.com"
const MISMATCH =
	"This authorization was started by a different Maple user or organization. Start it again from your own account."

/** Every call a stub received, so a test can assert who the services were asked to finish for. */
type Calls = Array<{ readonly service: string; readonly args: ReadonlyArray<unknown> }>

/** What every OAuth completion can fail with; chat installs add `IntegrationsForbiddenError`. */
type Failure = IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError

const PS_STATUS = new PlanetScaleIntegrationStatus({
	connected: true,
	pendingOrgSelection: false,
	organization: "acme-0",
	connectedByUserId: SESSION.userId,
	detectedPermissions: null,
	metricsAuth: "oauth",
	scrapeTarget: null,
	lastInventoryAt: null,
	lastInventoryError: null,
	revokedAt: null,
	expiresAt: null,
})

const SB_STATUS = new SupabaseIntegrationStatus({
	configured: true,
	connected: true,
	organization: null,
	connectedByUserId: SESSION.userId,
	connectedAt: null,
	revoked: false,
	lastDiscoveryAt: null,
	lastDiscoveryError: null,
	projects: [],
})

const harness = (
	calls: Calls,
	options: {
		readonly fail?: Failure
		readonly chatFail?: Failure | IntegrationsForbiddenError
		readonly psOrgs?: number
	} = {},
) => {
	const record = (service: string, args: ReadonlyArray<unknown>) =>
		Effect.sync(() => calls.push({ service, args }))
	const outcome = <A>(value: A) =>
		options.fail === undefined ? Effect.succeed(value) : Effect.fail(options.fail)
	const granted = { orgId: ORG, returnTo: "/integrations?integration=hazel" }
	return Layer.mergeAll(
		Layer.mock(HazelOAuthService, {
			completeConnect: (...args) => record("hazel", args).pipe(Effect.andThen(outcome(granted))),
		}),
		Layer.mock(CloudflareOAuthService, {
			completeConnect: (...args) =>
				record("cloudflare", args).pipe(Effect.andThen(outcome({ ...granted, returnTo: null }))),
		}),
		Layer.mock(CloudflareAnalyticsService, {
			resetOrgState: (orgId) => record("cloudflare.reset", [orgId]),
		}),
		Layer.mock(PlanetScaleOAuthService, {
			completeConnect: (...args) =>
				record("planetscale", args).pipe(
					Effect.andThen(
						outcome({
							...granted,
							organizations: Array.from({ length: options.psOrgs ?? 1 }, (_, i) => ({
								id: `ps_${i}`,
								name: `acme-${i}`,
							})),
						}),
					),
				),
		}),
		Layer.mock(PlanetScaleConnectionService, {
			finalizeOrgSelection: (orgId, request) =>
				record("planetscale.finalize", [orgId, request.organization]).pipe(Effect.as(PS_STATUS)),
		}),
		Layer.mock(SupabaseOAuthService, {
			isConfigured: true,
			apiBaseUrl: SUPABASE_API,
			completeConnect: (...args) =>
				record("supabase", args).pipe(
					Effect.andThen(
						outcome({
							...granted,
							connectedByUserId: SESSION.userId,
							organization: { id: "sb_1", slug: "acme", name: "Acme" },
						}),
					),
				),
		}),
		Layer.mock(SupabaseConnectionService, {
			finalizeConnect: (...args) => record("supabase.finalize", args).pipe(Effect.as(SB_STATUS)),
		}),
		Layer.mock(GithubConnectService, {
			completeConnect: (...args) =>
				record("github", args).pipe(
					Effect.andThen(outcome({ orgId: ORG, returnTo: "https://evil.example/" })),
				),
		}),
		Layer.mock(ChatWorkspaceService, {
			completeInstall: (...args) =>
				record("chat.install", args).pipe(
					Effect.andThen(
						options.chatFail === undefined
							? Effect.succeed({ orgId: ORG, name: "Acme HQ" })
							: Effect.fail(options.chatFail),
					),
				),
			completeLink: (...args) =>
				record("chat.link", args).pipe(Effect.andThen(outcome({ orgId: ORG, displayName: "ada" }))),
		}),
	)
}

const run = <A, E>(
	calls: Calls,
	use: (completer: Effect.Success<typeof makeIntegrationCompleter>) => Effect.Effect<A, E>,
	options?: Parameters<typeof harness>[1],
) => Effect.flatMap(makeIntegrationCompleter, use).pipe(Effect.provide(harness(calls, options)))

describe("makeIntegrationCompleter", () => {
	it.effect.each([
		["hazel", "code=c1&state=s1"],
		["cloudflare", "code=c1&state=s1"],
		["planetscale", "code=c1&state=s1"],
		["supabase", `code=c1&state=s1&iss=${encodeURIComponent(`${SUPABASE_API}/`)}`],
	] as const)(
		"finishes %s for the signed-in session, with the forwarded code and state",
		([provider, query]) => {
			const calls: Calls = []
			return Effect.gen(function* () {
				const response = yield* run(calls, (completer) =>
					completer.completeOAuth(SESSION, provider, query),
				)
				assert.strictEqual(response.status, "success")
				assert.deepStrictEqual(calls[0], { service: provider, args: [SESSION, "c1", "s1"] })
			})
		},
	)

	it.effect("finishes a GitHub install for the session and drops a return link off the dashboard", () => {
		const calls: Calls = []
		return Effect.gen(function* () {
			const response = yield* run(calls, (completer) =>
				completer.completeOAuth(
					SESSION,
					"github",
					"installation_id=42&setup_action=install&code=c1&state=s1",
				),
			)
			assert.strictEqual(response.status, "success")
			assert.isNull(response.returnTo)
			assert.deepStrictEqual(calls[0], { service: "github", args: [SESSION, "42", "s1", "c1"] })
		})
	})

	it.effect("shows the service's refusal of a session that did not start the flow", () => {
		const calls: Calls = []
		return Effect.gen(function* () {
			const response = yield* run(
				calls,
				(completer) => completer.completeOAuth(SESSION, "hazel", "code=c1&state=s1"),
				{ fail: new IntegrationsValidationError({ message: MISMATCH }) },
			)
			assert.deepStrictEqual(
				{ status: response.status, message: response.message, returnTo: response.returnTo },
				{ status: "error", message: MISMATCH, returnTo: null },
			)
		})
	})

	it.effect.each([
		[
			new IntegrationsUpstreamError({ message: "Token exchange failed: 400" }),
			"Token exchange failed: 400",
		],
		[
			new IntegrationsPersistenceError({ message: "db down" }),
			"Failed to complete the Cloudflare connection",
		],
	] as const)("reduces a %s failure to its copy", ([error, copy]) => {
		const calls: Calls = []
		return Effect.gen(function* () {
			const response = yield* run(
				calls,
				(completer) => completer.completeOAuth(SESSION, "cloudflare", "code=c1&state=s1"),
				{ fail: error },
			)
			assert.strictEqual(response.message, copy)
		})
	})

	it.effect.each([
		["supabase", "code=c1&state=s1&iss=https%3A%2F%2Fevil.example", "unexpected issuer"],
		["hazel", "state=s1", "Missing code or state"],
		["hazel", "error=access_denied&error_description=Denied", "Denied"],
		["github", "setup_action=request&state=s1", "an org admin must approve it"],
	] as const)("refuses a %s callback before calling any service: %s", ([provider, query, copy]) => {
		const calls: Calls = []
		return Effect.gen(function* () {
			const response = yield* run(calls, (completer) =>
				completer.completeOAuth(SESSION, provider, query),
			)
			assert.strictEqual(response.status, "error")
			assert.include(response.message, copy)
			assert.lengthOf(calls, 0)
		})
	})

	it.effect("binds a single-org PlanetScale grant and leaves several to the picker", () => {
		const one: Calls = []
		const many: Calls = []
		return Effect.gen(function* () {
			yield* run(one, (completer) =>
				completer.completeOAuth(SESSION, "planetscale", "code=c1&state=s1"),
			)
			assert.deepStrictEqual(one[1], { service: "planetscale.finalize", args: [ORG, "acme-0"] })
			const picker = yield* run(
				many,
				(completer) => completer.completeOAuth(SESSION, "planetscale", "code=c1&state=s1"),
				{ psOrgs: 2 },
			)
			assert.include(picker.message, "Choose which PlanetScale organization")
			assert.lengthOf(many, 1)
		})
	})

	it.effect("finishes a chat install and an account link for the session", () => {
		const calls: Calls = []
		return Effect.gen(function* () {
			const installed = yield* run(calls, (completer) =>
				completer.completeChat(SESSION, SLACK, "install", "code=c1&state=s1"),
			)
			const linked = yield* run(calls, (completer) =>
				completer.completeChat(SESSION, SLACK, "identity", "code=c2&state=s2"),
			)
			assert.deepStrictEqual([installed.name, linked.name], ["Acme HQ", "ada"])
			assert.deepStrictEqual(
				calls.map(({ service, args }) => [service, args[0], args[1]]),
				[
					["chat.install", SESSION, SLACK],
					["chat.link", SESSION, SLACK],
				],
			)
		})
	})

	it.effect.each([
		[new IntegrationsValidationError({ message: MISMATCH }), "state"],
		[new IntegrationsForbiddenError({ message: "linked elsewhere" }), "conflict"],
		[new IntegrationsPersistenceError({ message: "db down" }), "failed"],
	] as const)("maps a chat failure to its reason code: %s", ([error, reason]) => {
		const calls: Calls = []
		return Effect.gen(function* () {
			const response = yield* run(
				calls,
				(completer) => completer.completeChat(SESSION, SLACK, "install", "code=c1&state=s1"),
				{ chatFail: error },
			)
			assert.deepStrictEqual(
				{ status: response.status, reason: response.reason, name: response.name },
				{ status: "error", reason, name: null },
			)
		})
	})
})
