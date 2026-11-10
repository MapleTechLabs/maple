import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Array as Arr } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { CloudflareCustomHostnames } from "./CloudflareCustomHostnames"

const API = "https://cloudflare.test/client/v4"
const ZONE = "zone-1"

const CONFIGURED = {
	MAPLE_CLOUDFLARE_API_BASE_URL: API,
	MAPLE_STATUS_DOMAINS_ZONE_ID: ZONE,
	MAPLE_STATUS_DOMAINS_API_TOKEN: "cf-token",
	MAPLE_STATUS_DOMAINS_CNAME_TARGET: "status-domains.maple.test",
	MAPLE_STATUS_WORKER_NAME: "maple-status-pr-7",
}

interface SentRequest {
	readonly url: string
	readonly method: string
	readonly authorization: string | undefined
	readonly body: unknown
}

/** An HttpClient answering each request with `respond`, recording what was sent. */
const fakeCloudflare = (respond: (request: SentRequest) => Response, sent: Array<SentRequest>) =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request, url) =>
			Effect.sync(() => {
				const body =
					request.body._tag === "Uint8Array"
						? JSON.parse(new TextDecoder().decode(request.body.body))
						: undefined
				const recorded: SentRequest = {
					url: url.toString(),
					method: request.method,
					authorization: request.headers.authorization,
					body,
				}
				sent.push(recorded)
				return HttpClientResponse.fromWeb(request, respond(recorded))
			}),
		),
	)

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** The real client over a scripted Cloudflare API; `requests` records what it sent. */
const withClient = <A, E>(
	respond: (request: SentRequest) => Response,
	body: (
		client: CloudflareCustomHostnames["Service"],
		requests: ReadonlyArray<SentRequest>,
	) => Effect.Effect<A, E>,
	env: Record<string, unknown> = CONFIGURED,
) => {
	const requests: Array<SentRequest> = []
	const layer = Layer.effect(CloudflareCustomHostnames, CloudflareCustomHostnames.make).pipe(
		Layer.provide(fakeCloudflare(respond, requests)),
		Layer.provide(testEnv(env)),
	)
	return CloudflareCustomHostnames.use((client) => body(client, requests)).pipe(Effect.provide(layer))
}

const hostnameResult = {
	id: "cfh-1",
	hostname: "status.acme.com",
	status: "pending",
	ssl: {
		status: "pending_validation",
		validation_records: [{ txt_name: "_acme-challenge.status.acme.com", txt_value: "token" }],
		validation_errors: [{ message: "caa blocks issuance" }],
	},
	ownership_verification: { type: "txt", name: "_cf-custom-hostname.status.acme.com", value: "owner" },
	verification_errors: ["custom hostname does not CNAME to this zone."],
}

describe("CloudflareCustomHostnames", () => {
	it.effect("creates a DV hostname validated over HTTP and reads Cloudflare's answer", () =>
		withClient(
			() => json({ success: true, errors: [], result: hostnameResult }),
			(client, requests) =>
				Effect.gen(function* () {
					const state = yield* client.createHostname("status.acme.com")
					assert.deepStrictEqual(state, {
						id: "cfh-1",
						hostname: "status.acme.com",
						status: "pending",
						sslStatus: "pending_validation",
						ownership: { name: "_cf-custom-hostname.status.acme.com", value: "owner" },
						validationRecords: [
							{ txtName: "_acme-challenge.status.acme.com", txtValue: "token" },
						],
						errors: ["custom hostname does not CNAME to this zone.", "caa blocks issuance"],
					})
					assert.strictEqual(requests[0]?.method, "POST")
					assert.strictEqual(requests[0]?.url, `${API}/zones/${ZONE}/custom_hostnames`)
					assert.strictEqual(requests[0]?.authorization, "Bearer cf-token")
					assert.deepInclude(requests[0]?.body, {
						hostname: "status.acme.com",
						ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
					})
				}),
		),
	)

	it.effect("answers a duplicate hostname with a conflict", () =>
		withClient(
			() =>
				json(
					{ success: false, errors: [{ code: 1406, message: "Duplicate custom hostname found." }] },
					409,
				),
			(client) =>
				Effect.gen(function* () {
					const error = yield* Effect.flip(client.createHostname("status.acme.com"))
					assert.strictEqual(error._tag, "@maple/backend/status-pages/CustomHostnameConflictError")
				}),
		),
	)

	it.effect("reads a hostname gone at Cloudflare as none, and deleting it again as done", () =>
		withClient(
			() => json({ success: false, errors: [{ code: 1436, message: "not found" }], result: null }, 404),
			(client) =>
				Effect.gen(function* () {
					assert.isTrue(Option.isNone(yield* client.getHostname("cfh-1")))
					yield* client.deleteHostname("cfh-1")
				}),
		),
	)

	it.effect("routes the hostname to this stage's status Worker", () =>
		withClient(
			() =>
				json({ success: true, errors: [], result: { id: "route-1", pattern: "status.acme.com/*" } }),
			(client, requests) =>
				Effect.gen(function* () {
					assert.strictEqual(yield* client.createRoute("status.acme.com"), "route-1")
					assert.strictEqual(requests[0]?.url, `${API}/zones/${ZONE}/workers/routes`)
					assert.deepStrictEqual(requests[0]?.body, {
						pattern: "status.acme.com/*",
						script: "maple-status-pr-7",
					})
				}),
		),
	)

	it.effect("takes over a route the pattern already has", () =>
		withClient(
			(request) =>
				request.method === "POST"
					? json(
							{ success: false, errors: [{ code: 10020, message: "route already exists" }] },
							409,
						)
					: request.method === "GET"
						? json({
								success: true,
								errors: [],
								result: [{ id: "route-old", pattern: "status.acme.com/*" }],
							})
						: json({
								success: true,
								errors: [],
								result: { id: "route-old", pattern: "status.acme.com/*" },
							}),
			(client, requests) =>
				Effect.gen(function* () {
					assert.strictEqual(yield* client.createRoute("status.acme.com"), "route-old")
					assert.deepStrictEqual(
						Arr.map(requests, (request) => request.method),
						["POST", "GET", "PUT"],
					)
				}),
		),
	)

	it.effect("refuses every call where custom domains are not configured, and offers no CNAME target", () =>
		withClient(
			() => json({ success: true }),
			(client, requests) =>
				Effect.gen(function* () {
					assert.isTrue(Option.isNone(client.cnameTarget))
					const error = yield* Effect.flip(client.createHostname("status.acme.com"))
					assert.strictEqual(
						error._tag,
						"@maple/backend/status-pages/CustomHostnamesNotConfiguredError",
					)
					assert.strictEqual(requests.length, 0)
				}),
			{ MAPLE_CLOUDFLARE_API_BASE_URL: API },
		),
	)
})
