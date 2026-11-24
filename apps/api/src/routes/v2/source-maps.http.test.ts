import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { inMemoryObjectStore, sourceMapBucketLayer } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { SourceMapService } from "@maple/backend/services/sourcemaps/SourceMapService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import { HttpV2SourceMapsLive } from "./source-maps.http"
import { ApiV2RateLimiterAllowAllLayer, Phase1ResourceStubsLayer } from "./v2-test-support"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3482",
		MCP_PORT: "3483",
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

const ORG = Schema.decodeSync(OrgId)("org_source_maps_e2e")
const USER = Schema.decodeSync(UserId)("user_source_maps_e2e")
const DEBUG_ID = "6c5e2b1a-1f2e-4d3c-8b7a-0123456789ab"

const makeHarness = () => {
	const objects = new Map<string, Uint8Array>()
	const servicesLive = Layer.mergeAll(ApiKeysService.layer, AuthService.layer, SourceMapService.layer).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Env.layer.pipe(Layer.provide(testConfig)),
				createTestDb(createdDbs).layer,
				sourceMapBucketLayer(inMemoryObjectStore(objects)),
			),
		),
	)
	const routes = HttpApiBuilder.layer(HttpApi.make("MapleApiV2").add(MapleApiV2.groups.sourceMaps)).pipe(
		Layer.provide(HttpV2SourceMapsLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const createKey = (options: { scopes?: ReadonlyArray<string>; roles?: ReadonlyArray<string> } = {}) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const keys = yield* ApiKeysService
				return yield* keys.create(ORG, USER, {
					name: "source-maps-test",
					scopes: options.scopes,
					...(options.roles === undefined
						? undefined
						: {
								metadataJson: {
									source: "maple_cli",
									roles: options.roles,
									deviceName: "laptop",
								},
							}),
				})
			}),
		)

	const request = async (
		method: string,
		path: string,
		token: string,
		body?: {
			readonly bytes: Uint8Array<ArrayBuffer>
			readonly contentType: string
			readonly contentLength?: number
		},
	) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? undefined : { "content-type": body.contentType }),
					...(body?.contentLength === undefined
						? undefined
						: { "content-length": String(body.contentLength) }),
				},
				body: body?.bytes,
			}),
			Context.empty(),
		)
		const text = await response.text()
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null }
	}

	return {
		objects,
		createKey,
		request,
		dispose: async () => {
			await dispose()
			await runtime.dispose()
		},
	}
}

const mapBody = (contentType = "application/octet-stream") => ({
	bytes: new TextEncoder().encode(
		JSON.stringify({
			version: 3,
			sources: ["src/a.ts"],
			sourcesContent: ["x"],
			names: [],
			mappings: "AAAA",
		}),
	),
	contentType,
})

describe("v2 source_maps over HTTP", () => {
	it("uploads raw bytes, lists and deletes with the public wire shape", async () => {
		const harness = makeHarness()
		const key = await harness.createKey({ scopes: ["source_maps:write"] })

		const uploaded = await harness.request(
			"POST",
			`/v2/source_maps?minified_path=/assets/index-Bx81.js&debug_id=${DEBUG_ID}`,
			key.secret,
			mapBody(),
		)
		expect(uploaded.status).toBe(200)
		expect(uploaded.body).toMatchObject({
			object: "source_map",
			debug_id: DEBUG_ID,
			service: null,
			version: null,
			minified_path: "assets/index-Bx81.js",
			has_sources_content: true,
			last_used_at: null,
		})
		expect(uploaded.body.id).toMatch(/^smap_/)
		expect(uploaded.body.size_bytes).toBe(mapBody().bytes.byteLength)
		expect(harness.objects.size).toBe(1)

		const asJson = await harness.request(
			"POST",
			"/v2/source_maps?minified_path=assets/b.js&service=web&version=1.0.0",
			key.secret,
			mapBody("application/json"),
		)
		expect(asJson.status).toBe(200)

		const listed = await harness.request("GET", "/v2/source_maps?service=web&limit=1", key.secret)
		expect(listed.status).toBe(200)
		expect(listed.body).toMatchObject({ object: "list", has_more: false, next_cursor: null })
		expect(listed.body.data.map((row: { id: string }) => row.id)).toEqual([asJson.body.id])

		const deleted = await harness.request("DELETE", `/v2/source_maps/${uploaded.body.id}`, key.secret)
		expect(deleted.status).toBe(200)
		expect(deleted.body.id).toBe(uploaded.body.id)
		expect(harness.objects.size).toBe(1)

		const missing = await harness.request("DELETE", `/v2/source_maps/${uploaded.body.id}`, key.secret)
		expect(missing.status).toBe(404)
		expect(missing.body.error._tag).toBe("@maple/http/sourcemaps/SourceMapNotFoundError")
		await harness.dispose()
	})

	it("refuses a body over 10 MiB by its Content-Length, and one that runs over while read", async () => {
		const harness = makeHarness()
		const key = await harness.createKey({ scopes: ["source_maps:write"] })
		const path = `/v2/source_maps?minified_path=assets/a.js&debug_id=${DEBUG_ID}`

		// The header alone decides: the small body behind it is never read.
		const declared = await harness.request("POST", path, key.secret, {
			...mapBody(),
			contentLength: 10 * 1024 * 1024 + 1,
		})
		expect(declared.status).toBe(413)
		expect(declared.body.error._tag).toBe("@maple/http/sourcemaps/SourceMapTooLargeError")

		const oversized = await harness.request("POST", path, key.secret, {
			bytes: new Uint8Array(10 * 1024 * 1024 + 1),
			contentType: "application/octet-stream",
		})
		expect(oversized.status).toBe(413)
		expect(harness.objects.size).toBe(0)
		await harness.dispose()
	})

	it("rejects an upload that cannot be matched, a read-only key and a member", async () => {
		const harness = makeHarness()
		const writer = await harness.createKey()

		const unmatched = await harness.request(
			"POST",
			"/v2/source_maps?minified_path=assets/a.js&service=web",
			writer.secret,
			mapBody(),
		)
		expect(unmatched.status).toBe(400)
		expect(unmatched.body.error).toMatchObject({
			_tag: "@maple/http/sourcemaps/SourceMapInvalidError",
			param: "debug_id",
		})

		const reader = await harness.createKey({ scopes: ["source_maps:read"] })
		const readOnly = await harness.request(
			"POST",
			`/v2/source_maps?minified_path=assets/a.js&debug_id=${DEBUG_ID}`,
			reader.secret,
			mapBody(),
		)
		expect(readOnly.status).toBe(403)
		expect((await harness.request("GET", "/v2/source_maps", reader.secret)).status).toBe(200)

		const member = await harness.createKey({ roles: ["org:member"] })
		const memberUpload = await harness.request(
			"POST",
			`/v2/source_maps?minified_path=assets/a.js&debug_id=${DEBUG_ID}`,
			member.secret,
			mapBody(),
		)
		expect(memberUpload.status).toBe(403)
		expect(memberUpload.body.error._tag).toBe("@maple/http/v2/InsufficientPermissionsError")
		expect((await harness.request("GET", "/v2/source_maps", member.secret)).status).toBe(200)
		expect(harness.objects.size).toBe(0)
		await harness.dispose()
	})
})
