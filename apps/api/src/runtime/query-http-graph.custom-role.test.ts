import { describe, expect, it, vi } from "vitest"
import { Context, Effect, Scope } from "effect"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Policy from "@maple/domain/policy"
import { buildApp } from "../worker/http"
import { offlinePortsWith } from "../../test/offline-http-ports"

// Clerk binds `fetch` when it loads, so its API is faked before any import runs. Only a user's
// memberships answer; everything else (the region read) is a 404.
const clerkApi = vi.hoisted(() => {
	const memberships = new Map<string, ReadonlyArray<number>>()
	globalThis.fetch = async (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		const match = /^\/v1\/users\/([^/]+)\/organization_memberships$/.exec(url.pathname)
		const codes = match === null ? undefined : memberships.get(match[1] ?? "")
		if (codes === undefined)
			return Response.json({ errors: [{ code: "resource_not_found" }] }, { status: 404 })
		return Response.json({
			data: [
				{
					object: "organization_membership",
					id: "orgmem_1",
					role: "org:custom",
					permissions: [],
					public_metadata: { maple_role: { id: "role_abcdefabcdef", permissions: codes } },
					private_metadata: {},
					created_at: 0,
					updated_at: 0,
					organization: {
						object: "organization",
						id: "org_custom",
						name: "Custom",
						slug: "custom",
						public_metadata: {},
						private_metadata: {},
						created_at: 0,
						updated_at: 0,
					},
					public_user_data: { user_id: match?.[1], identifier: "member@maple.test" },
				},
			],
			total_count: 1,
		})
	}
	return { memberships }
})

const base64Url = (bytes: ArrayBuffer | Uint8Array) =>
	Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url")

const keys = await crypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	},
	true,
	["sign", "verify"],
)
const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(
	await crypto.subtle.exportKey("spki", keys.publicKey),
).toString("base64")}\n-----END PUBLIC KEY-----`

/** A Clerk session token for `userId` on `org_custom` as an `org:custom` member. */
const sessionToken = async (userId: string) => {
	const now = Math.floor(Date.now() / 1000)
	const encode = (value: Record<string, unknown>) =>
		base64Url(new TextEncoder().encode(JSON.stringify(value)))
	// `cat` is the category Clerk stamps on session tokens; without it the token reads as a machine's.
	const header = { alg: "RS256", typ: "JWT", kid: "ins_test", cat: "cl_B7d4PD111AAA" }
	const unsigned = `${encode(header)}.${encode({
		sub: userId,
		sid: `sess_${userId}`,
		iat: now - 10,
		nbf: now - 10,
		exp: now + 600,
		v: 2,
		o: { id: "org_custom", rol: "custom", slg: "custom" },
	})}`
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		keys.privateKey,
		new TextEncoder().encode(unsigned),
	)
	return `${unsigned}.${base64Url(signature)}`
}

const ports = offlinePortsWith({
	MAPLE_AUTH_MODE: "clerk",
	CLERK_SECRET_KEY: "sk_test_offline",
	CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.maple.test$").toString("base64")}`,
	CLERK_JWT_KEY: publicKeyPem,
	TINYBIRD_SIGNING_KEY: "offline-signing-key",
	TINYBIRD_WORKSPACE_ID: "offline-workspace",
})

const post = (handler: Effect.Success<ReturnType<typeof buildApp>>, path: string, token: string) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const responseEffect: Effect.Effect<Response, never, Scope.Scope> =
					Cloudflare.Workers.makeRequestHandler(handler)({
						kind: "Cloudflare.Workers.WorkerEvent",
						type: "fetch",
						input: new Request(`http://api.test${path}`, {
							method: "POST",
							headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
							body: "{}",
						}),
					})
				const response = yield* responseEffect
				return { status: response.status, body: yield* Effect.promise(() => response.text()) }
			}),
		).pipe(Effect.provide(ports)),
	)

describe("dashboard query graph, custom roles", () => {
	it("reads an org:custom session's permissions from the membership directory", async () => {
		clerkApi.memberships.set("user_reader", Policy.encodePermissions(["telemetry:read"]))
		clerkApi.memberships.set("user_nothing", [])
		const handler = await Effect.runPromise(buildApp(Context.empty(), ports, "query"))

		// Past the permission check, an empty body is a bad request.
		const reader = await post(
			handler,
			"/internal/query-engine/execute-batch",
			await sessionToken("user_reader"),
		)
		expect(reader.status, reader.body).toBe(400)

		const nothing = await post(
			handler,
			"/internal/query-engine/execute-batch",
			await sessionToken("user_nothing"),
		)
		expect(nothing.status, nothing.body).toBe(403)
	})
})
