import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	AlertDestinationDocument,
	AlertDestinationsListResponse,
	type AlertDestinationCreateRequest,
	type AlertDestinationUpdateRequest,
	ChatConnectorId,
	ChatWorkspaceId,
	IntegrationsConfigurationError,
	IntegrationsNotConnectedError,
	IntegrationsNotFoundError,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { ChatWorkspacePublicId, MapleApiV2 } from "@maple/domain/http/v2"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { ApiAuthorizationV2Layer } from "@maple/backend/services/auth/ApiAuthorizationV2Layer"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import {
	ChatWorkspaceService,
	type ChatWorkspaceServiceApi,
} from "@maple/backend/services/integrations/ChatWorkspaceService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	allV2GroupLayersWithChat,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	GoogleAnalyticsServiceStubsLayer,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/**
 * The `chat` alert destination over HTTP: the workspace channel listing behind the picker (admin
 * gate, wire shape, the failures a reader acts on), and the destination create/update mapping.
 * The services are fakes; the router, auth and error envelopes are real.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const API_HOST = "api.maple.test"
const WORKSPACE = Schema.decodeUnknownSync(ChatWorkspaceId)("11111111-1111-4111-8111-111111111111")
const WORKSPACE_PUBLIC_ID = Schema.encodeSync(ChatWorkspacePublicId)(WORKSPACE)
const TESTCHAT = Schema.decodeUnknownSync(ChatConnectorId)("testchat")

const testConfig = () =>
	ConfigProvider.layer(
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
			MAPLE_APP_BASE_URL: "https://app.maple.test",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const die = () => Effect.die(new Error("not stubbed in this test"))

const chatLayer = (listDestinations: ChatWorkspaceServiceApi["listDestinations"]) =>
	Layer.succeed(
		ChatWorkspaceService,
		ChatWorkspaceService.of({
			list: die,
			beginInstall: die,
			completeInstall: die,
			beginLink: die,
			completeLink: die,
			unlink: die,
			updateSettings: die,
			uninstall: die,
			listDestinations,
			resolve: die,
		}),
	)

const destinationDocument = (channelLabel: string) =>
	new AlertDestinationDocument({
		id: Schema.decodeUnknownSync(AlertDestinationDocument.fields.id)(
			"7c6b5a49-3821-4e0f-9d8c-7b6a59483726",
		),
		name: "Incidents",
		type: "chat",
		enabled: true,
		summary: "Acme Engineering",
		channelLabel,
		memberUserIds: null,
		chatConnector: TESTCHAT,
		chatWorkspaceId: WORKSPACE,
		lastTestedAt: null,
		lastTestError: null,
		createdAt: Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)(
			"2026-09-24T00:00:00.000Z",
		),
		updatedAt: Schema.decodeUnknownSync(AlertDestinationDocument.fields.updatedAt)(
			"2026-09-24T00:00:00.000Z",
		),
	})

interface Recorded {
	create?: AlertDestinationCreateRequest
	update?: AlertDestinationUpdateRequest
}

const destinationsLayer = (recorded: Recorded) =>
	Layer.succeed(AlertDestinationsService, {
		// The update route reads the stored destination for its audit diff.
		listDestinations: () =>
			Effect.succeed(
				new AlertDestinationsListResponse({ destinations: [destinationDocument("#incidents")] }),
			),
		deleteDestination: die,
		listTelegramChats: die,
		testDestination: die,
		createDestination: (_orgId, _userId, _roles, request) =>
			Effect.sync(() => {
				recorded.create = request
				return destinationDocument("#incidents")
			}),
		updateDestination: (_orgId, _userId, _roles, _id, request) =>
			Effect.sync(() => {
				recorded.update = request
				return destinationDocument("#oncall")
			}),
	})

const makeHarness = (
	listDestinations: ChatWorkspaceServiceApi["listDestinations"] = die,
	recorded: Recorded = {},
) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(allV2GroupLayersWithChat(chatLayer(listDestinations))),
		Layer.provide(V2TransportErrorBoundaryLive),
		// Before the facade stubs, so this fake is the destination service the routes see.
		Layer.provide(destinationsLayer(recorded)),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(GoogleAnalyticsServiceStubsLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)
	const ORG = Schema.decodeUnknownSync(OrgId)("org_chat_dest_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_chat_dest_e2e")

	const key = (metadataJson?: Record<string, unknown>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: "chat-dest",
					...(metadataJson === undefined ? undefined : { metadataJson }),
				})
			}),
		)

	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://${API_HOST}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? undefined : { "content-type": "application/json" }),
				},
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	return {
		adminKey: () => key(),
		memberKey: () => key({ source: "maple_cli", roles: ["org:member"], deviceName: "laptop" }),
		request,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

const DESTINATIONS_PATH = `/v2/integrations/chat_workspaces/${WORKSPACE_PUBLIC_ID}/destinations`

describe("v2 chat workspace destinations over HTTP", () => {
	it("lists the channels for an admin, in the wire shape", async () => {
		const seen: Array<ChatWorkspaceId> = []
		const harness = makeHarness((_orgId, workspaceId) =>
			Effect.sync(() => {
				seen.push(workspaceId)
				return [{ id: "channel-1", name: "incidents", private: false }]
			}),
		)
		const { status, body } = await harness.request(
			"GET",
			DESTINATIONS_PATH,
			(await harness.adminKey()).secret,
		)
		expect(status).toBe(200)
		expect(body).toEqual({
			object: "chat_workspace.destination_list",
			destinations: [{ id: "channel-1", name: "incidents", private: false }],
		})
		// The public id is decoded to the row id before it reaches the service.
		expect(seen).toEqual([WORKSPACE])
		await harness.dispose()
	})

	it("refuses a member with 403 and never asks the platform", async () => {
		let called = false
		const harness = makeHarness(() =>
			Effect.sync(() => {
				called = true
				return []
			}),
		)
		const { status, body } = await harness.request(
			"GET",
			DESTINATIONS_PATH,
			(await harness.memberKey()).secret,
		)
		expect(status).toBe(403)
		expect(body.error).toMatchObject({ type: "permission_error" })
		expect(called).toBe(false)
		await harness.dispose()
	})

	it.each([
		[
			new IntegrationsNotFoundError({ message: "No chat workspace with this id" }),
			404,
			"integration_not_found",
		],
		[
			new IntegrationsNotConnectedError({
				message: "Reinstall Test Chat from Integrations to grant channel access.",
			}),
			409,
			"integration_not_connected",
		],
		[
			new IntegrationsConfigurationError({ message: "Test Chat is not configured on this deployment" }),
			503,
			"integration_not_configured",
		],
	] as const)("puts %s on the wire", async (failure, expectedStatus, code) => {
		const harness = makeHarness(() => Effect.fail(failure))
		const { status, body } = await harness.request(
			"GET",
			DESTINATIONS_PATH,
			(await harness.adminKey()).secret,
		)
		expect(status).toBe(expectedStatus)
		expect(body.error).toMatchObject({ code })
		if (code === "integration_not_connected") expect(body.error.message).toContain("Reinstall")
		await harness.dispose()
	})
})

describe("v2 chat alert destination mapping", () => {
	it("creates from the public workspace id and a channel id, and returns the connector", async () => {
		const recorded: Recorded = {}
		const harness = makeHarness(die, recorded)
		const { status, body } = await harness.request(
			"POST",
			"/v2/alerts/destinations",
			(await harness.adminKey()).secret,
			{
				type: "chat",
				name: "Incidents",
				workspace_id: WORKSPACE_PUBLIC_ID,
				channel_id: "channel-1",
			},
		)
		expect(status).toBe(200)
		expect(recorded.create).toMatchObject({
			type: "chat",
			name: "Incidents",
			workspaceId: WORKSPACE,
			channelId: "channel-1",
		})
		expect(body).toMatchObject({
			type: "chat",
			chat_connector: "testchat",
			chat_workspace_id: WORKSPACE_PUBLIC_ID,
			channel_label: "#incidents",
		})
		await harness.dispose()
	})

	it("updates the channel alone", async () => {
		const recorded: Recorded = {}
		const harness = makeHarness(die, recorded)
		const created = await harness.request(
			"POST",
			"/v2/alerts/destinations",
			(await harness.adminKey()).secret,
			{
				type: "chat",
				name: "Incidents",
				workspace_id: WORKSPACE_PUBLIC_ID,
				channel_id: "channel-1",
			},
		)
		const { status, body } = await harness.request(
			"PATCH",
			`/v2/alerts/destinations/${created.body.id}`,
			(await harness.adminKey()).secret,
			{ type: "chat", channel_id: "channel-2" },
		)
		expect(status).toBe(200)
		expect(recorded.update).toEqual({ type: "chat", channelId: "channel-2" })
		expect(body.channel_label).toBe("#oncall")
		await harness.dispose()
	})
})
