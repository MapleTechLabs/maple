import { generateKeyPairSync, createHash, randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { EdgeCacheService } from "@maple/cache"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { DeviceCredentialsService } from "@maple/backend/services/auth/DeviceCredentialsService"
import { AppAttestTrustAnchor } from "@maple/backend/services/auth/device/app-attest"
import { MembershipRevocationService } from "@maple/backend/services/auth/MembershipRevocationService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { makeSyntheticAttestation } from "@maple/backend/testing/app-attest-fixture"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	Phase1ResourceStubsLayer,
	PlanetScaleServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/**
 * `/v2/device_credentials` + `/v2/device_tokens` + `Authorization: DPoP` over an embedded
 * PGlite, with a real ES256 device key per test. Every rejection case starts from a request
 * that succeeds, so each one isolates the single check it is about.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const BASE = "http://maple.test"
const TEAM_ID = "TEAMID1234"
const APP_ID = `${TEAM_ID}.com.maple.mobile`
const ORG = Schema.decodeUnknownSync(OrgId)("org_device_cred")
const USER = Schema.decodeUnknownSync(UserId)("user_device_cred")
const INSTALLATION = "F9E1B4C0-8F2A-4C6D-9E1B-4C08F2A4C6D9"
const SIGNING_KEY = generateKeyPairSync("ec", {
	namedCurve: "P-256",
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey

const b64url = (bytes: Uint8Array | string) =>
	(typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes)).toString("base64url")

interface DeviceKey {
	readonly keys: CryptoKeyPair
	readonly jwk: { kty: "EC"; crv: "P-256"; x: string; y: string }
	readonly jkt: string
}

const newDeviceKey = async (): Promise<DeviceKey> => {
	const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])
	const exported = await crypto.subtle.exportKey("jwk", keys.publicKey)
	const jwk = { kty: "EC" as const, crv: "P-256" as const, x: exported.x ?? "", y: exported.y ?? "" }
	const jkt = b64url(
		createHash("sha256")
			.update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
			.digest(),
	)
	return { keys, jwk, jkt }
}

interface AttestationWire {
	readonly key_id: string
	readonly attestation_object: string
	readonly challenge: string
}

interface ProofOptions {
	readonly htm: string
	readonly htu: string
	readonly iat?: number
	readonly jti?: string
	readonly accessToken?: string
	readonly ath?: string
	/** Sign with this key while still presenting `key.jwk` in the header. */
	readonly signWith?: CryptoKey
}

const proof = async (key: DeviceKey, options: ProofOptions) => {
	const header = b64url(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: key.jwk }))
	const ath =
		options.ath ??
		(options.accessToken === undefined
			? undefined
			: b64url(createHash("sha256").update(options.accessToken).digest()))
	const payload = b64url(
		JSON.stringify({
			jti: options.jti ?? randomUUID(),
			htm: options.htm,
			htu: options.htu,
			iat: options.iat ?? Math.floor(Date.now() / 1000),
			...(ath === undefined ? undefined : { ath }),
		}),
	)
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		options.signWith ?? key.keys.privateKey,
		new TextEncoder().encode(`${header}.${payload}`),
	)
	return `${header}.${payload}.${b64url(new Uint8Array(signature))}`
}

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3492",
			MCP_PORT: "3493",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_API_BASE_URL: BASE,
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
			MAPLE_DEVICE_TOKEN_SIGNING_KEY: SIGNING_KEY,
			APNS_TEAM_ID: TEAM_ID,
		}),
	)

const edgeCacheStub = Layer.succeed(EdgeCacheService, {
	getOrCompute: (_options, compute) =>
		compute.pipe(Effect.map((value) => ({ value, status: "miss" as const, readMs: 0, wrote: false }))),
	invalidate: () => Effect.void,
	rawGetDetailed: () => Effect.succeed({ status: "miss" as const, value: Option.none(), readMs: 0 }),
	rawGet: () => Effect.succeed(Option.none()),
	rawPut: () => Effect.void,
	rawDelete: () => Effect.void,
})

const makeHarness = (trustAnchor?: Uint8Array) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const base = Layer.mergeAll(envLive, testDb.layer, edgeCacheStub)
	const devices = DeviceCredentialsService.layer.pipe(
		trustAnchor === undefined
			? (layer) => layer
			: Layer.provide(Layer.succeed(AppAttestTrustAnchor, trustAnchor)),
	)
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		MobileDevicesService.layer,
		LiveActivitiesService.layer,
		MembershipRevocationService.layer,
		devices,
	).pipe(Layer.provideMerge(base))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const send = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
		const response = await handler(
			new Request(`${BASE}${path}`, {
				method,
				headers: {
					...headers,
					...(body === undefined ? undefined : { "content-type": "application/json" }),
				},
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return {
			status: response.status,
			body: text.length === 0 ? null : JSON.parse(text),
			wwwAuthenticate: response.headers.get("www-authenticate"),
		}
	}

	const sessionKey = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return (yield* service.create(ORG, USER, { name: "device-cred-test" })).secret
			}),
		)

	const register = (
		secret: string,
		key: DeviceKey,
		attestation?: AttestationWire,
		installation = INSTALLATION,
	) =>
		send(
			"PUT",
			`/v2/device_credentials/${installation}`,
			{ authorization: `Bearer ${secret}` },
			{
				public_jwk: key.jwk,
				...(attestation === undefined ? undefined : { attestation }),
			},
		)

	const token = async (key: DeviceKey, options: Partial<ProofOptions> = {}) =>
		send("POST", "/v2/device_tokens", {
			dpop: await proof(key, { htm: "POST", htu: `${BASE}/v2/device_tokens`, ...options }),
		})

	const call = async (
		method: string,
		path: string,
		key: DeviceKey,
		accessToken: string,
		options: Partial<ProofOptions> = {},
	) =>
		send(method, path, {
			authorization: `DPoP ${accessToken}`,
			dpop: await proof(key, { htm: method, htu: `${BASE}${path}`, accessToken, ...options }),
		})

	/** A registered key and a token for it: the starting point of most cases. */
	const enrolled = async () => {
		const secret = await sessionKey()
		const key = await newDeviceKey()
		const registered = await register(secret, key)
		expect(registered.status).toBe(200)
		const issued = await token(key)
		expect(issued.status).toBe(200)
		return { secret, key, accessToken: String(issued.body.access_token) }
	}

	const sql = (statement: string, params: ReadonlyArray<unknown>) =>
		testDb.pglite.query(statement, [...params])

	return {
		send,
		sessionKey,
		register,
		token,
		call,
		enrolled,
		sql,
		runtime,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

type Harness = ReturnType<typeof makeHarness>

const withHarness = (body: (harness: Harness) => Promise<void>, trustAnchor?: Uint8Array) => async () => {
	const harness = makeHarness(trustAnchor)
	try {
		await body(harness)
	} finally {
		await harness.dispose()
	}
}

const isAuthorized = (status: number) => status !== 401 && status !== 403

describe("device credential registration", () => {
	it(
		"registers a key with server-chosen scopes and expiries",
		withHarness(async (harness) => {
			const secret = await harness.sessionKey()
			const key = await newDeviceKey()
			const registered = await harness.register(secret, key)
			expect(registered.status).toBe(200)
			expect(registered.body.object).toBe("device_credential")
			expect(registered.body.id).toMatch(/^dcred_/)
			expect(registered.body.jkt).toBe(key.jkt)
			expect(registered.body.scopes).toEqual(["widget_summary:read"])
			expect(registered.body.attested).toBe(false)
			const created = Date.parse(registered.body.created_at)
			expect(Date.parse(registered.body.expires_at) - created).toBe(30 * 24 * 60 * 60 * 1000)
			expect(Date.parse(registered.body.hard_expires_at) - created).toBe(90 * 24 * 60 * 60 * 1000)
		}),
	)

	it(
		"replaces and revokes the installation's previous key",
		withHarness(async (harness) => {
			const first = await harness.enrolled()
			const second = await newDeviceKey()
			expect((await harness.register(first.secret, second)).status).toBe(200)

			const oldToken = await harness.token(first.key)
			expect(oldToken.status).toBe(401)
			expect(oldToken.body.error.code).toBe("invalid_device_credential")
			// A token issued before the replacement dies with its credential.
			expect(
				(await harness.call("GET", "/v2/widget_summary", first.key, first.accessToken)).status,
			).toBe(401)
			expect((await harness.token(second)).status).toBe(200)
		}),
	)

	it(
		"never registers a retired key again",
		withHarness(async (harness) => {
			const first = await harness.enrolled()
			await harness.register(first.secret, await newDeviceKey())
			const reused = await harness.register(first.secret, first.key)
			expect(reused.status).toBe(409)
			expect(reused.body.error.code).toBe("device_key_in_use")
		}),
	)

	it(
		"refreshes the same key in place",
		withHarness(async (harness) => {
			const { secret, key } = await harness.enrolled()
			await harness.sql("update device_credentials set expires_at = now() + interval '1 day'", [])
			const refreshed = await harness.register(secret, key)
			expect(refreshed.status).toBe(200)
			expect(Date.parse(refreshed.body.expires_at)).toBeGreaterThan(
				Date.now() + 29 * 24 * 60 * 60 * 1000,
			)
			expect((await harness.token(key)).status).toBe(200)
		}),
	)

	it(
		"rejects a key that is not on the P-256 curve",
		withHarness(async (harness) => {
			const secret = await harness.sessionKey()
			const key = await newDeviceKey()
			const offCurve = { ...key, jwk: { ...key.jwk, y: key.jwk.x } }
			const registered = await harness.register(secret, offCurve)
			expect(registered.status).toBe(400)
			expect(registered.body.error.code).toBe("device_key_invalid")
		}),
	)
})

describe("device token issuance", () => {
	it(
		"issues a DPoP-bound token that reaches the widget summary",
		withHarness(async (harness) => {
			const secret = await harness.sessionKey()
			const key = await newDeviceKey()
			await harness.register(secret, key)
			const issued = await harness.token(key)
			expect(issued.status).toBe(200)
			expect(issued.body).toMatchObject({
				object: "device_token",
				token_type: "DPoP",
				expires_in: 3600,
				scope: "widget_summary:read",
			})
			const [, payload] = String(issued.body.access_token).split(".")
			const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))
			expect(claims).toMatchObject({
				iss: BASE,
				aud: "maple-api-device",
				org_id: ORG,
				cnf: { jkt: key.jkt },
			})
			expect(claims.exp - claims.iat).toBe(3600)

			const summary = await harness.call(
				"GET",
				"/v2/widget_summary",
				key,
				String(issued.body.access_token),
			)
			expect(isAuthorized(summary.status)).toBe(true)
		}),
	)

	it(
		"rejects a proof for another URL",
		withHarness(async (harness) => {
			const { key } = await harness.enrolled()
			const issued = await harness.token(key, { htu: `${BASE}/v2/device_credentials` })
			expect(issued.status).toBe(400)
			expect(issued.body.error.code).toBe("invalid_dpop_proof")
		}),
	)

	it(
		"rejects a proof for another method",
		withHarness(async (harness) => {
			const { key } = await harness.enrolled()
			expect((await harness.token(key, { htm: "GET" })).status).toBe(400)
		}),
	)

	it(
		"rejects a stale proof",
		withHarness(async (harness) => {
			const { key } = await harness.enrolled()
			expect((await harness.token(key, { iat: Math.floor(Date.now() / 1000) - 120 })).status).toBe(400)
			expect((await harness.token(key, { iat: Math.floor(Date.now() / 1000) + 120 })).status).toBe(400)
		}),
	)

	it(
		"rejects a replayed proof",
		withHarness(async (harness) => {
			const { key } = await harness.enrolled()
			const jti = randomUUID()
			expect((await harness.token(key, { jti })).status).toBe(200)
			const replayed = await harness.token(key, { jti })
			expect(replayed.status).toBe(400)
			expect(replayed.body.error.code).toBe("invalid_dpop_proof")
		}),
	)

	it(
		"rejects a proof signed by a key other than the one it presents",
		withHarness(async (harness) => {
			const { key } = await harness.enrolled()
			const other = await newDeviceKey()
			expect((await harness.token(key, { signWith: other.keys.privateKey })).status).toBe(400)
		}),
	)

	it(
		"rejects an unregistered key",
		withHarness(async (harness) => {
			const issued = await harness.token(await newDeviceKey())
			expect(issued.status).toBe(401)
			expect(issued.body.error.code).toBe("invalid_device_credential")
		}),
	)

	it(
		"rejects a request without a proof",
		withHarness(async (harness) => {
			const issued = await harness.send("POST", "/v2/device_tokens", {})
			expect(issued.status).toBe(400)
			expect(issued.body.error.code).toBe("invalid_dpop_proof")
		}),
	)
})

describe("DPoP-authenticated requests", () => {
	it(
		"rejects a token presented with another registered key's proof",
		withHarness(async (harness) => {
			const { accessToken } = await harness.enrolled()
			const thief = await harness.enrolled()
			const response = await harness.call("GET", "/v2/widget_summary", thief.key, accessToken)
			expect(response.status).toBe(401)
			expect(response.wwwAuthenticate).toContain('error="invalid_dpop_proof"')
		}),
	)

	it(
		"rejects a proof whose ath is not the token's hash",
		withHarness(async (harness) => {
			const { key, accessToken } = await harness.enrolled()
			const response = await harness.call("GET", "/v2/widget_summary", key, accessToken, {
				ath: b64url("not the hash"),
			})
			expect(response.status).toBe(401)
			expect(response.body.error.code).toBe("invalid_dpop_proof")
			expect(response.wwwAuthenticate).toContain('error="invalid_dpop_proof"')
		}),
	)

	it(
		"rejects a token without a proof",
		withHarness(async (harness) => {
			const { accessToken } = await harness.enrolled()
			const response = await harness.send("GET", "/v2/widget_summary", {
				authorization: `DPoP ${accessToken}`,
			})
			expect(response.status).toBe(401)
			expect(response.wwwAuthenticate).toContain('error="invalid_dpop_proof"')
		}),
	)

	it(
		"rejects a replayed request proof",
		withHarness(async (harness) => {
			const { key, accessToken } = await harness.enrolled()
			const jti = randomUUID()
			expect(
				isAuthorized(
					(await harness.call("GET", "/v2/widget_summary", key, accessToken, { jti })).status,
				),
			).toBe(true)
			expect((await harness.call("GET", "/v2/widget_summary", key, accessToken, { jti })).status).toBe(
				401,
			)
		}),
	)

	it(
		"rejects a proof for another path",
		withHarness(async (harness) => {
			const { key, accessToken } = await harness.enrolled()
			const response = await harness.call("GET", "/v2/widget_summary", key, accessToken, {
				htu: `${BASE}/v2/services`,
			})
			expect(response.status).toBe(401)
		}),
	)

	it(
		"rejects a token this server did not sign",
		withHarness(async (harness) => {
			const { key, accessToken } = await harness.enrolled()
			const [header, payload] = accessToken.split(".")
			const forged = `${header}.${payload}.${b64url(new Uint8Array(64))}`
			const response = await harness.call("GET", "/v2/widget_summary", key, forged)
			expect(response.status).toBe(401)
			expect(response.wwwAuthenticate).toContain('error="invalid_token"')
		}),
	)

	it(
		"can only read the widget summary",
		withHarness(async (harness) => {
			const { key, accessToken } = await harness.enrolled()
			for (const path of ["/v2/error_issues", "/v2/services", "/v2/api_keys", "/v2/mobile_devices"]) {
				expect((await harness.call("GET", path, key, accessToken)).status).toBe(403)
			}
			// Nor renew itself: registration needs `device_credentials:write`.
			const renew = await harness.call(
				"DELETE",
				`/v2/device_credentials/${INSTALLATION}`,
				key,
				accessToken,
			)
			expect(renew.status).toBe(403)
		}),
	)
})

describe("device credential lifecycle", () => {
	it(
		"stops a revoked credential at the token endpoint and on every request",
		withHarness(async (harness) => {
			const { secret, key, accessToken } = await harness.enrolled()
			const revoked = await harness.send("DELETE", `/v2/device_credentials/${INSTALLATION}`, {
				authorization: `Bearer ${secret}`,
			})
			expect(revoked.status).toBe(200)
			expect((await harness.token(key)).status).toBe(401)
			const response = await harness.call("GET", "/v2/widget_summary", key, accessToken)
			expect(response.status).toBe(401)
			expect(response.wwwAuthenticate).toContain('error="invalid_token"')
		}),
	)

	it(
		"stops an expired credential",
		withHarness(async (harness) => {
			const { key, accessToken } = await harness.enrolled()
			await harness.sql("update device_credentials set expires_at = now() - interval '1 second'", [])
			expect((await harness.token(key)).status).toBe(401)
			expect((await harness.call("GET", "/v2/widget_summary", key, accessToken)).status).toBe(401)
		}),
	)

	it(
		"stops a credential past its hard cap even inside the rolling window",
		withHarness(async (harness) => {
			const { key } = await harness.enrolled()
			await harness.sql(
				"update device_credentials set hard_expires_at = now() - interval '1 second'",
				[],
			)
			expect((await harness.token(key)).status).toBe(401)
		}),
	)

	it(
		"stops the credentials of someone who left the organization",
		withHarness(async (harness) => {
			const { key, accessToken } = await harness.enrolled()
			await harness.runtime.runPromise(
				Effect.gen(function* () {
					const revocation = yield* MembershipRevocationService
					const summary = yield* revocation.revokeMembership(ORG, USER)
					expect(summary.deviceCredentialsRevoked).toBe(1)
				}),
			)
			expect((await harness.token(key)).status).toBe(401)
			expect((await harness.call("GET", "/v2/widget_summary", key, accessToken)).status).toBe(401)
		}),
	)
})

describe("App Attest at registration", () => {
	const attestedRegistration = async (
		harness: Harness,
		override: { readonly clientJkt?: string; readonly installation?: string } = {},
	) => {
		const secret = await harness.sessionKey()
		const key = await newDeviceKey()
		const challenge = await harness.send(
			"GET",
			`/v2/device_credentials/${override.installation ?? INSTALLATION}/attestation_challenge`,
			{ authorization: `Bearer ${secret}` },
		)
		expect(challenge.status).toBe(200)
		return { secret, key, challenge: String(challenge.body.challenge) }
	}

	const attest = async (challenge: string, jkt: string) => {
		const clientDataHash = new Uint8Array(createHash("sha256").update(`${challenge}.${jkt}`).digest())
		const built = await makeSyntheticAttestation({ appId: APP_ID, clientDataHash })
		const attestation: AttestationWire = {
			key_id: Buffer.from(built.keyId).toString("base64"),
			attestation_object: Buffer.from(built.attestationObject).toString("base64"),
			challenge,
		}
		return { attestation, root: built.rootCertificate }
	}

	// The trust anchor is fixed when the service is built, so each case builds its attestation
	// first under a generated root, then a harness that trusts that root.
	const run = async (
		body: (
			harness: Harness,
			registration: Awaited<ReturnType<typeof attestedRegistration>>,
			attestation: AttestationWire,
		) => Promise<void>,
		options: { readonly bindTo?: (key: DeviceKey) => Promise<string> } = {},
	) => {
		const seed = makeHarness()
		const registration = await attestedRegistration(seed)
		await seed.dispose()
		const jkt =
			options.bindTo === undefined ? registration.key.jkt : await options.bindTo(registration.key)
		const { attestation, root } = await attest(registration.challenge, jkt)
		const harness = makeHarness(root)
		try {
			await body(harness, { ...registration, secret: await harness.sessionKey() }, attestation)
		} finally {
			await harness.dispose()
		}
	}

	it("marks a credential attested when its attestation verifies", () =>
		run(async (harness, { secret, key }, attestation) => {
			const registered = await harness.register(secret, key, attestation)
			expect(registered.status).toBe(200)
			expect(registered.body.attested).toBe(true)
		}))

	it("rejects an attestation bound to a different key", () =>
		run(
			async (harness, { secret, key }, attestation) => {
				const registered = await harness.register(secret, key, attestation)
				expect(registered.status).toBe(400)
				expect(registered.body.error.code).toBe("device_attestation_invalid")
			},
			{ bindTo: async () => (await newDeviceKey()).jkt },
		))

	it("accepts each challenge once", () =>
		run(async (harness, { secret, key }, attestation) => {
			expect((await harness.register(secret, key, attestation)).status).toBe(200)
			// The same key and attestation again: only the spent challenge differs from success.
			const replayed = await harness.register(secret, key, attestation)
			expect(replayed.status).toBe(400)
			expect(replayed.body.error.code).toBe("device_attestation_invalid")
		}))

	it("rejects a challenge issued for another installation", () =>
		run(async (harness, { secret, key }, attestation) => {
			const registered = await harness.register(
				secret,
				key,
				attestation,
				"A1B2C3D4-8F2A-4C6D-9E1B-4C08F2A4C6D9",
			)
			expect(registered.status).toBe(400)
			expect(registered.body.error.code).toBe("device_attestation_invalid")
		}))
})
