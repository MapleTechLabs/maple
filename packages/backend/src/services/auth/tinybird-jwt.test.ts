// BOUNDARY-FILE: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { createHmac } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import { mintOrgReadJwt } from "./tinybird-jwt"
import { Array as Arr, String as Str } from "effect"

const decodePart = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"))

const SIGNING_KEY = "explicit-test-signing-key"

describe("mintOrgReadJwt", () => {
	it("produces a well-formed HS256 JWT with the right header, exp, and scopes", () => {
		const jwt = mintOrgReadJwt({
			signingKey: SIGNING_KEY,
			workspaceId: "ws-uuid-123",
			orgId: "org_abc",
			datasourceNames: ["traces", "logs"],
			nowSeconds: 1_000,
			ttlSeconds: 600,
		})

		const [header, payload, signature] = Str.split(".")(jwt)
		assert.deepStrictEqual(decodePart(header), { alg: "HS256", typ: "JWT" })

		const decoded = decodePart(payload) as {
			workspace_id: string
			name: string
			exp: number
			scopes: ReadonlyArray<{ type: string; resource: string; filter: string }>
		}
		assert.strictEqual(decoded.workspace_id, "ws-uuid-123")
		assert.match(decoded.name, /^maple-raw-sql-[0-9a-f]{16}$/)
		assert.notInclude(decoded.name, "org_abc")
		assert.strictEqual(decoded.exp, 1_600)
		assert.deepStrictEqual(decoded.scopes, [
			{ type: "DATASOURCES:READ", resource: "traces", filter: "OrgId = 'org_abc'" },
			{ type: "DATASOURCES:READ", resource: "logs", filter: "OrgId = 'org_abc'" },
		])

		// Signature verifies independently against the explicit signing key.
		const expected = createHmac("sha256", SIGNING_KEY).update(`${header}.${payload}`).digest("base64url")
		assert.strictEqual(signature, expected)
	})

	it("adds an org-isolated Tinybird rate-limit bucket when configured", () => {
		const tokenFor = (orgId: string) =>
			mintOrgReadJwt({
				signingKey: SIGNING_KEY,
				workspaceId: "ws-uuid-123",
				orgId,
				datasourceNames: ["traces"],
				nowSeconds: 1_000,
				ttlSeconds: 600,
				rpsLimit: 25,
			})
		const decode = (token: string) =>
			decodePart(Str.split(".")(token)[1]) as { name: string; limits: { rps: number } }

		const a = decode(tokenFor("org_a"))
		const b = decode(tokenFor("org_b"))
		assert.deepStrictEqual(a.limits, { rps: 25 })
		assert.deepStrictEqual(b.limits, { rps: 25 })
		assert.notStrictEqual(a.name, b.name)
	})

	it("escapes single quotes in the org id to prevent filter injection", () => {
		const jwt = mintOrgReadJwt({
			signingKey: SIGNING_KEY,
			workspaceId: "ws-uuid-123",
			orgId: "org_' OR 1=1 --",
			datasourceNames: ["traces"],
			nowSeconds: 0,
			ttlSeconds: 60,
		})
		const decoded = decodePart(Str.split(".")(jwt)[1]) as {
			scopes: ReadonlyArray<{ filter: string }>
		}
		// The embedded quote is backslash-escaped, so the ClickHouse literal stays closed.
		assert.strictEqual(decoded.scopes[0].filter, "OrgId = 'org_\\' OR 1=1 --'")
	})

	it("stops a datasource at its read bound and leaves the others on the org filter", () => {
		const jwt = mintOrgReadJwt({
			signingKey: SIGNING_KEY,
			workspaceId: "ws-uuid-123",
			orgId: "org_abc",
			datasourceNames: ["traces", "logs", "trace_index"],
			readBounds: new Map([
				["traces", { column: "Timestamp", days: 7 }],
				["trace_index", { column: "Bucket", days: 7, bucketMinutes: 5 }],
				// Not a datasource of this token: it adds no scope.
				["metrics_sum", { column: "TimeUnix", days: 7 }],
			]),
			nowSeconds: 0,
			ttlSeconds: 60,
		})
		const decoded = decodePart(Str.split(".")(jwt)[1] ?? "") as {
			scopes: ReadonlyArray<{ type: string; resource: string; filter: string }>
		}
		assert.deepStrictEqual(decoded.scopes, [
			{
				type: "DATASOURCES:READ",
				resource: "traces",
				filter: "OrgId = 'org_abc' AND Timestamp >= now() - INTERVAL 7 DAY",
			},
			{ type: "DATASOURCES:READ", resource: "logs", filter: "OrgId = 'org_abc'" },
			{
				type: "DATASOURCES:READ",
				resource: "trace_index",
				filter: "OrgId = 'org_abc' AND Bucket >= now() - INTERVAL 7 DAY - INTERVAL 5 MINUTE",
			},
		])
	})

	it("leaves every datasource on the bare org filter when there are no bounds", () => {
		const jwt = mintOrgReadJwt({
			signingKey: SIGNING_KEY,
			workspaceId: "ws-uuid-123",
			orgId: "org_abc",
			datasourceNames: ["traces", "logs"],
			readBounds: new Map(),
			nowSeconds: 1_000,
			ttlSeconds: 600,
		})
		const decoded = decodePart(Str.split(".")(jwt)[1] ?? "") as {
			scopes: ReadonlyArray<{ resource: string; filter: string }>
		}
		assert.deepStrictEqual(
			Arr.map(decoded.scopes, (scope) => [scope.resource, scope.filter]),
			[
				["traces", "OrgId = 'org_abc'"],
				["logs", "OrgId = 'org_abc'"],
			],
		)
	})
})
