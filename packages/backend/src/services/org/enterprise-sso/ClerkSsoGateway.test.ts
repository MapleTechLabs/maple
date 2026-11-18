import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { ClerkRequestError } from "@maple/backend/services/auth/clerk-request"
import { disambiguatedName, isNameTaken, scanClaimedDomains, updateParams } from "./ClerkSsoGateway"

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
			assert.strictEqual(error._tag, "@maple/backend/services/auth/ClerkRequestError")
		}),
	)

	it.effect("fails closed when Clerk sends an empty page before its own total", () =>
		Effect.gen(function* () {
			const short = (offset: number) =>
				offset === 0 ? connections(250)(0) : Effect.succeed({ totalCount: 250, data: [] })
			const error = yield* scanClaimedDomains(short, "ent_0", ["partner.io"]).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/backend/services/auth/ClerkRequestError")
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
			assert.strictEqual(error._tag, "@maple/backend/services/auth/ClerkRequestError")
		}),
	)
})

describe("connection update body", () => {
	it("closes other sign-in methods when SSO is required, and never reopens them", () => {
		assert.deepStrictEqual(updateParams({ active: true }), {
			active: true,
			disableAdditionalIdentifications: true,
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
	const clerkError = (status: number, errors: unknown) =>
		new ClerkRequestError({ operation: "create", message: "x", status, cause: { errors } })

	it("recognises Clerk's taken-name error, and nothing else", () => {
		assert.isTrue(
			isNameTaken(clerkError(422, [{ code: "form_identifier_exists", meta: { paramName: "name" } }])),
		)
		assert.isFalse(
			isNameTaken(
				clerkError(422, [{ code: "form_identifier_exists", meta: { paramName: "domains" } }]),
			),
		)
		assert.isFalse(
			isNameTaken(clerkError(400, [{ code: "form_identifier_exists", meta: { paramName: "name" } }])),
		)
	})

	it("disambiguates with the org's own domain", () => {
		assert.strictEqual(disambiguatedName("Okta", ["acme.com", "acme.io"]), "Okta (acme.com)")
	})
})
