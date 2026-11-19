import { assert, describe, it } from "@effect/vitest"
import { makeClerkApi } from "@maple/auth"
import { OrgId } from "@maple/domain/http"
import { Array as Arr, Effect, Layer, Redacted, Schema, String as Str } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import {
	disambiguatedName,
	isNameHeldElsewhere,
	makeClerkSsoGateway,
	scanClaimedDomains,
	updateParams,
} from "./ClerkSsoGateway"

/** `total` connections, the last one serving `partner.io`; pages of 100 like Clerk's. */
const connections = (total: number) => (offset: number) =>
	Effect.succeed({
		totalCount: total,
		data: Arr.map(Arr.range(offset, Math.min(offset + 100, total) - 1), (i) => ({
			id: `ent_${i}`,
			domains: i === total - 1 ? ["Partner.io"] : [`org${i}.example`],
		})),
	})

describe("scanClaimedDomains", () => {
	it.effect("reads every page, so a connection on the last one still counts", () =>
		Effect.gen(function* () {
			const claimed = yield* scanClaimedDomains(connections(250), "ent_0", ["partner.io", "gmail.com"])
			assert.deepStrictEqual(claimed, ["partner.io"])
		}),
	)

	it.effect("ignores the caller's own connection", () =>
		Effect.gen(function* () {
			const claimed = yield* scanClaimedDomains(connections(3), "ent_2", ["partner.io"])
			assert.deepStrictEqual(claimed, [])
		}),
	)

	it.effect("fails closed when the scan cannot reach every connection", () =>
		Effect.gen(function* () {
			const error = yield* scanClaimedDomains(connections(250), "ent_0", ["partner.io"], 2).pipe(
				Effect.flip,
			)
			assert.strictEqual(error._tag, "@maple/auth/ClerkRequestError")
		}),
	)

	it.effect("fails closed when Clerk sends an empty page before its own total", () =>
		Effect.gen(function* () {
			const short = (offset: number) =>
				offset === 0 ? connections(250)(0) : Effect.succeed({ totalCount: 250, data: [] })
			const error = yield* scanClaimedDomains(short, "ent_0", ["partner.io"]).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/auth/ClerkRequestError")
		}),
	)

	it.effect("follows short pages by what Clerk returned, so no connection is skipped", () => {
		const offsets: Array<number> = []
		// 50 per page although the limit is 100; the partner connection is number 75.
		const shortPages = (offset: number) => {
			offsets.push(offset)
			return Effect.succeed({
				totalCount: 150,
				data: Arr.map(Arr.range(offset, Math.min(offset + 50, 150) - 1), (i) => ({
					id: `ent_${i}`,
					domains: i === 75 ? ["partner.io"] : [`org${i}.example`],
				})),
			})
		}
		return Effect.gen(function* () {
			const claimed = yield* scanClaimedDomains(shortPages, "ent_0", ["partner.io"])
			assert.deepStrictEqual(claimed, ["partner.io"])
			assert.deepStrictEqual(offsets, [0, 50, 100])
		})
	})

	it.effect("fails closed when a short page is followed by an empty one before the total", () =>
		Effect.gen(function* () {
			const pages = (offset: number) =>
				Effect.succeed(
					offset === 0
						? {
								totalCount: 100,
								data: Arr.map(Arr.range(0, 49), (i) => ({ id: `ent_${i}`, domains: [] })),
							}
						: { totalCount: 100, data: [] },
				)
			const error = yield* scanClaimedDomains(pages, "ent_0", ["partner.io"]).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/auth/ClerkRequestError")
		}),
	)
})

describe("connection update body", () => {
	it("closes other sign-in methods when SSO is required, and never reopens them", () => {
		assert.deepStrictEqual(updateParams({ active: true }), {
			active: true,
			disable_additional_identifications: true,
		})
		assert.deepStrictEqual(updateParams({ active: false }), { active: false })
	})

	it("leaves sign-in methods as they are on an edit that does not touch enforcement", () => {
		assert.deepStrictEqual(updateParams({ name: "Okta", domains: ["acme.com"] }), {
			name: "Okta",
			domains: ["acme.com"],
		})
	})
})

describe("connection name collisions", () => {
	/** Connections named after their index, with `Okta` held by `ent_owner` at position `at`. */
	const named =
		(total: number, at: number, pageSize = 100) =>
		(offset: number) =>
			Effect.succeed({
				totalCount: total,
				data: Arr.map(Arr.range(offset, Math.min(offset + pageSize, total) - 1), (i) =>
					i === at
						? { id: "ent_owner", name: "Okta" }
						: { id: `ent_${i}`, name: `Connection ${i}` },
				),
			})

	it.effect("finds the name held by another connection, whatever its case", () =>
		Effect.gen(function* () {
			assert.isTrue(yield* isNameHeldElsewhere(named(3, 1), null, "okta"))
			assert.isTrue(yield* isNameHeldElsewhere(named(3, 1), "ent_mine", "Okta"))
		}),
	)

	it.effect("does not count the connection being renamed, or a name nobody holds", () =>
		Effect.gen(function* () {
			assert.isFalse(yield* isNameHeldElsewhere(named(3, 1), "ent_owner", "Okta"))
			assert.isFalse(yield* isNameHeldElsewhere(named(3, 1), null, "Entra"))
		}),
	)

	it.effect("follows short pages to a holder past the first page", () =>
		Effect.gen(function* () {
			assert.isTrue(yield* isNameHeldElsewhere(named(150, 120, 50), null, "Okta"))
		}),
	)

	it("disambiguates with the org's own domain", () => {
		assert.strictEqual(disambiguatedName("Okta", ["acme.com", "acme.io"]), "Okta (acme.com)")
	})
})

/** A Clerk Backend API holding `existing` connections; create and update answer with `writeStatus` until the name is free. */
const fakeClerk = (existing: ReadonlyArray<{ id: string; name: string }>, writeStatus: number) => {
	const writes: Array<{ method: string; name: string }> = []
	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
	const connection = (id: string, name: string) => ({
		object: "enterprise_connection",
		id,
		name,
		provider: "saml_okta",
		active: true,
		domains: ["acme.com"],
		organization_id: "org_1",
		created_at: 0,
		updated_at: 0,
	})
	const http = Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) =>
			Effect.gen(function* () {
				const url = new URL(request.url)
				if (request.method === "GET") {
					return HttpClientResponse.fromWeb(
						request,
						json(200, {
							data: Arr.map(existing, (c) => connection(c.id, c.name)),
							total_count: existing.length,
						}),
					)
				}
				const body =
					request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}"
				const name = yield* Schema.decodeEffect(
					Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
				)(body).pipe(Effect.orDie)
				writes.push({ method: request.method, name: name.name })
				const taken = Arr.some(
					existing,
					(c) => Str.toLowerCase(c.name) === Str.toLowerCase(name.name),
				)
				const id = Str.startsWith("/v1/enterprise_connections/")(url.pathname)
					? Arr.lastNonEmpty(Str.split(url.pathname, "/"))
					: "ent_new"
				return HttpClientResponse.fromWeb(
					request,
					taken && writes.length === 1
						? json(writeStatus, {
								errors: [{ code: "form_identifier_exists", message: "taken" }],
							})
						: json(200, connection(id, name.name)),
				)
			}),
		),
	)
	return { gateway: makeClerkSsoGateway(makeClerkApi(Redacted.make("sk_test_fake"), http)), writes }
}

describe("taken connection names", () => {
	const input = { name: "Okta", domains: ["acme.com"] }

	it.effect(
		"a create refused with 422 over a name another org holds retries once, under the org's domain",
		() =>
			Effect.gen(function* () {
				const { gateway, writes } = fakeClerk([{ id: "ent_other", name: "okta" }], 422)
				const created = yield* gateway.createConnection(OrgId.make("org_1"), "saml_okta", input)
				assert.strictEqual(created.name, "Okta (acme.com)")
				assert.deepStrictEqual(
					Arr.map(writes, (w) => w.name),
					["Okta", "Okta (acme.com)"],
				)
			}),
	)

	it.effect("a 409 is not a taken name: it fails without a retry", () =>
		Effect.gen(function* () {
			const { gateway, writes } = fakeClerk([{ id: "ent_other", name: "Okta" }], 409)
			const error = yield* Effect.flip(
				gateway.createConnection(OrgId.make("org_1"), "saml_okta", input),
			)
			assert.strictEqual(error.status, 409)
			assert.strictEqual(writes.length, 1)
		}),
	)

	it.effect("an update whose name only its own connection holds fails without a retry", () =>
		Effect.gen(function* () {
			const { gateway, writes } = fakeClerk([{ id: "ent_mine", name: "Okta" }], 422)
			const error = yield* Effect.flip(gateway.updateConnection("ent_mine", input))
			assert.strictEqual(error.status, 422)
			assert.strictEqual(writes.length, 1)
		}),
	)
})
