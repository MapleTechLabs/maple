// BOUNDARY-FILE: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { describe, expect, it } from "@effect/vitest"
import { OpenApi } from "effect/http-api"
import * as Http from "./index"
import { Array as Arr, Record as Rec, String as Str } from "effect"

const prop = (value: unknown, key: string): unknown =>
	(typeof value === "object" || typeof value === "function") && value !== null && key in value
		? (value as Record<string, unknown>)[key]
		: undefined

interface TaggedErrorIdentity {
	readonly name: string
	readonly tag: string
	readonly status: number
	readonly hasMessage: boolean
}

const taggedErrorIdentity = (name: string, value: unknown): TaggedErrorIdentity | null => {
	const tag = prop(prop(prop(prop(value, "fields"), "_tag"), "schema"), "literal")
	const status = prop(prop(prop(value, "ast"), "annotations"), "httpApiStatus")
	const hasMessage =
		prop(value, "fields") !== undefined && prop(prop(value, "fields"), "message") !== undefined
	return typeof tag === "string" && typeof status === "number" ? { name, tag, status, hasMessage } : null
}

describe("HTTP error tag contract", () => {
	it("gives every exported tagged HTTP error one globally unique semantic identity", () => {
		const identities = Arr.filter(
			Arr.map(Rec.toEntries(Http), ([name, value]) => taggedErrorIdentity(name, value)),
			(identity): identity is NonNullable<typeof identity> => identity !== null,
		)
		const tags = Arr.map(identities, (identity) => identity.tag)

		expect(identities.length).toBeGreaterThan(100)
		expect(new Set(tags).size).toBe(tags.length)
		for (const { tag, status } of identities) {
			expect(tag, "tag is namespaced").toMatch(/^@maple\//)
			expect(status, tag).toBeGreaterThanOrEqual(400)
			expect(status, tag).toBeLessThan(600)
		}
	})

	it("gives every tagged HTTP error a useful message and stable status semantics", () => {
		const identities = Arr.filter(
			Arr.map(Rec.toEntries(Http), ([name, value]) => taggedErrorIdentity(name, value)),
			(identity): identity is NonNullable<typeof identity> => identity !== null,
		)

		for (const identity of identities) {
			expect(identity.hasMessage, `${identity.name} has a message field`).toBe(true)

			if (Str.endsWith("ValidationError")(identity.name)) {
				expect(identity.status, identity.name).toBe(400)
			}
			if (Str.endsWith("ForbiddenError")(identity.name)) {
				expect(identity.status, identity.name).toBe(403)
			}
			if (Str.endsWith("NotFoundError")(identity.name)) {
				expect(identity.status, identity.name).toBe(404)
			}
			if (Str.endsWith("PersistenceError")(identity.name)) {
				expect(identity.status, identity.name).toBe(503)
			}
			if (/RateLimitError$|QuotaError$|QuotaExceededError$/.test(identity.name)) {
				expect(identity.status, identity.name).toBe(429)
			}
			if (/ConflictError$|ConcurrencyError$|InUseError$/.test(identity.name)) {
				expect(identity.status, identity.name).toBe(409)
			}
		}
	})

	it.each([
		{ name: "MapleApi", spec: OpenApi.fromApi(Http.MapleApi) },
		{ name: "MapleInternalApi", spec: OpenApi.fromApi(Http.MapleInternalApi) },
	])(
		"declares the shared request-validation and unexpected-error boundary on every $name operation",
		({ spec }) => {
			const operations = Arr.flatMap(Rec.toEntries(spec.paths ?? {}), ([path, item]) =>
				Arr.map(
					// @effect-diagnostics-next-line preferEffectRecord:off -- not a record type; Rec.toEntries would need a cast
					Arr.filter(Object.entries(item ?? {}), ([method]) =>
						["get", "post", "put", "patch", "delete"].includes(method),
					),
					([method, operation]) => ({
						method,
						path,
						operation: operation as { readonly responses?: Record<string, unknown> },
					}),
				),
			)

			const missing = Arr.flatMap(operations, ({ method, path, operation }) =>
				Arr.map(
					Arr.filter(["400", "500"], (status) => operation.responses?.[status] === undefined),
					(status) => `${Str.toUpperCase(method)} ${path} ${status}`,
				),
			)
			expect(operations.length).toBeGreaterThan(0)
			expect(missing).toEqual([])
		},
	)
})
