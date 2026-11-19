import { describe, expect, it } from "@effect/vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	IntegrationsApiGroup,
	OrgId,
	RoleName,
	SearchConsoleSiteChoice,
	UserId,
} from "@maple/domain/http"
import { Array as Arr, ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { Env } from "@maple/backend/platform/Env"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { AwsConnectionService } from "@maple/backend/services/integrations/AwsConnectionService"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"
import { CloudflareAnalyticsService } from "@maple/backend/services/integrations/CloudflareAnalyticsService"
import { GcpConnectorService } from "@maple/backend/services/integrations/GcpConnectorService"
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import { FleetConnectionService } from "@maple/backend/services/integrations/FleetConnectionService"
import { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import { SearchConsoleImportService } from "@maple/backend/services/integrations/SearchConsoleImportService"
import { SearchConsoleService } from "@maple/backend/services/integrations/SearchConsoleService"
import { SupabaseConnectionService } from "@maple/backend/services/integrations/SupabaseConnectionService"
import { SupabaseInsightsService } from "@maple/backend/services/integrations/SupabaseInsightsService"
import { SupabaseLogsService } from "@maple/backend/services/integrations/SupabaseLogsService"
import { VercelIntegrationService } from "@maple/backend/services/integrations/VercelIntegrationService"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"
import { TelemetryServiceStubsLayer, WarehouseServiceStubLayer } from "@/routes/v2/v2-test-support"
import { HttpIntegrationsLive } from "./integrations.http"

/**
 * The two picker lists of `/internal/integrations` read the connected account live, so they take
 * `integrations:manage`. The router, the error boundary and the handlers are real; the session is
 * set per call and the provider services are fakes.
 */

class IntegrationsOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(IntegrationsApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG = Schema.decodeSync(OrgId)("org_pickers_route")
const USER = Schema.decodeSync(UserId)("user_pickers_route")
const asFailure = Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))

const TEAMS = [{ id: "team_1", key: "ENG", name: "Engineering" }]
const SITES = [
	new SearchConsoleSiteChoice({
		siteUrl: "sc-domain:acme.dev",
		permissionLevel: "siteOwner",
		selectable: true,
		enabled: true,
	}),
]

const testConfig = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3478",
		MCP_PORT: "3479",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		INTERNAL_SERVICE_TOKEN: "test-internal-token",
	}),
)

const unused = () => Effect.die("not used by the picker routes")

/** A service the group is built from and the picker routes never reach. */
const unreached = <Id, Service>(tag: Context.Key<Id, Service>) =>
	// SAFETY: no picker route calls a method of these services, so the empty value is never read.
	Layer.succeed(tag, {} as never)

const makeHarness = (role: string) => {
	const asked: Array<string> = []
	const authorization = Layer.succeed(
		CurrentTenant.SessionAuthorization,
		CurrentTenant.SessionAuthorization.of({
			bearer: (httpEffect) =>
				Effect.provideService(
					httpEffect,
					CurrentTenant.Context,
					new CurrentTenant.TenantSchema({
						orgId: ORG,
						userId: USER,
						roles: [Schema.decodeSync(RoleName)(role)],
						authMode: "clerk",
					}),
				),
		}),
	)
	const services = Layer.mergeAll(
		Layer.succeed(LinearOAuthService, {
			startConnect: unused,
			completeConnect: unused,
			getStatus: unused,
			getFeatures: unused,
			setFeatures: unused,
			getValidAccessToken: unused,
			listTeams: () =>
				Effect.sync(() => {
					asked.push("linear")
					return TEAMS
				}),
			getTeam: unused,
			disconnect: unused,
		}),
		Layer.succeed(SearchConsoleService, {
			getStatus: unused,
			listAvailableSites: () =>
				Effect.sync(() => {
					asked.push("search-console")
					return SITES
				}),
			saveSites: unused,
		}),
		unreached(GoogleOAuthService),
		unreached(SearchConsoleImportService),
		unreached(GithubConnectService),
		unreached(VcsCommitService),
		unreached(VcsSourceService),
		unreached(CloudflareOAuthService),
		unreached(CloudflareAnalyticsService),
		unreached(RailwayMetricsService),
		unreached(FleetConnectionService),
		unreached(VercelIntegrationService),
		unreached(SupabaseOAuthService),
		unreached(SupabaseConnectionService),
		unreached(SupabaseLogsService),
		unreached(SupabaseInsightsService),
		unreached(GcpConnectorService),
		unreached(PlanetScaleConnectionService),
		unreached(PlanetScaleOAuthService),
		unreached(AwsConnectionService),
		unreached(ChatWorkspaceService),
		WarehouseServiceStubLayer,
		TelemetryServiceStubsLayer,
		EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive)),
		Env.layer.pipe(Layer.provide(testConfig)),
		AuditLogService.layerMemory,
	)
	const routes = HttpApiBuilder.layer(IntegrationsOnlyApi).pipe(
		Layer.provide(HttpIntegrationsLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provideMerge(authorization),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })

	const get = async (path: string) => {
		const response = await handler(
			new Request(`http://maple.test/internal/integrations${path}`, {
				headers: { authorization: "Bearer test-token" },
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text === "" ? null : JSON.parse(text) }
	}

	return { get, asked, dispose }
}

const PICKERS = ["/linear/teams", "/google-search-console/sites"]

describe("/internal/integrations picker lists", () => {
	it.each(["org:analyst", "org:member"])(
		"refuses %s, and never reads the connected account for them",
		async (role) => {
			const harness = makeHarness(role)
			const responses = await Promise.all(Arr.map(PICKERS, (path) => harness.get(path)))
			expect(Arr.map(responses, (response) => response.status)).toEqual([403, 403])
			expect(Arr.map(responses, (response) => asFailure(response.body)._tag)).toEqual([
				"@maple/http/errors/IntegrationsForbiddenError",
				"@maple/http/errors/IntegrationsForbiddenError",
			])
			expect(harness.asked).toEqual([])
			await harness.dispose()
		},
	)

	// An engineer holds both `alerts:manage` and `integrations:manage`: the Linear list takes either.
	it("lists the account's teams and properties for a member who manages alerts and integrations", async () => {
		const harness = makeHarness("org:engineer")
		const teams = await harness.get("/linear/teams")
		expect([teams.status, teams.body]).toEqual([200, { teams: TEAMS }])
		const sites = await harness.get("/google-search-console/sites")
		expect(sites.status).toBe(200)
		expect(sites.body.sites).toEqual([
			{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner", selectable: true, enabled: true },
		])
		expect(harness.asked).toEqual(["linear", "search-console"])
		await harness.dispose()
	})
})
