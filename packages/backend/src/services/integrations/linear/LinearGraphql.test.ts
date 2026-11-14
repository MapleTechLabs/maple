import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { isNotFound, linearGraphql } from "./LinearGraphql"

const QUERY = "query MapleIssue($id: String!) { issue(id: $id) { id } }"
const MUTATION =
	"mutation MapleIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success } }"

/** Answers with `replies` in turn, the last one for good. */
const linear = (replies: ReadonlyArray<() => Response>) => {
	let served = 0
	const fake = VendorFake.make({
		routes: [
			{
				path: "/graphql",
				respond: () => {
					const reply = replies[Math.min(served, replies.length - 1)]
					served++
					return reply?.()
				},
			},
		],
	})
	return { fake, layer: Layer.merge(FetchHttpClient.layer, fake.layer) }
}

const send = (query: string, name: string) =>
	Effect.gen(function* () {
		return yield* linearGraphql(yield* HttpClient.HttpClient, "lin-token", name, query)
	})

describe("linearGraphql", () => {
	it.effect("sends a query again after a passing 5xx", () => {
		const server = linear([
			() => VendorFake.text("bad gateway", 502),
			() => VendorFake.json({ data: { issue: { id: "i1" } } }),
		])
		return Effect.gen(function* () {
			const result = yield* VendorFake.elapsing(send(QUERY, "MapleIssue"))
			assert.deepStrictEqual(result, { data: { issue: { id: "i1" } }, errors: [] })
			assert.strictEqual(server.fake.calls.length, 2)
			assert.strictEqual(server.fake.calls[0]?.authorization, "Bearer lin-token")
		}).pipe(Effect.provide(server.layer))
	})

	it.effect("sends a mutation once, so a 5xx never creates an issue twice", () => {
		const server = linear([() => VendorFake.text("bad gateway", 502)])
		return Effect.gen(function* () {
			const error = yield* send(MUTATION, "MapleIssueCreate").pipe(Effect.flip)
			assert.deepStrictEqual(
				[error._tag, error.message],
				["@maple/http/errors/IntegrationsUpstreamError", "Linear API returned 502"],
			)
			assert.strictEqual(server.fake.calls.length, 1)
		}).pipe(Effect.provide(server.layer))
	})

	it.effect("reads not found from a 400 body longer than the kit keeps", () => {
		const server = linear([
			() =>
				VendorFake.json(
					{
						data: null,
						errors: [
							{
								message: "Could not find referenced Issue.",
								extensions: { code: "INPUT_ERROR", meta: Str.repeat(3_000)("x") },
							},
						],
					},
					400,
				),
		])
		return Effect.gen(function* () {
			const result = yield* send(QUERY, "MapleIssue")
			assert.isTrue(result.errors.length === 1 && Arr.every(result.errors, isNotFound))
		}).pipe(Effect.provide(server.layer))
	})

	it.effect("reads not found from a 400 whose own message is longer than the kit keeps", () => {
		const server = linear([
			() =>
				VendorFake.json(
					{
						data: null,
						errors: [
							{
								message: `Could not find referenced Issue. ${Str.repeat(3_000)("x")}`,
								extensions: { code: "INPUT_ERROR" },
							},
						],
					},
					400,
				),
		])
		return Effect.gen(function* () {
			const result = yield* send(QUERY, "MapleIssue")
			assert.isTrue(result.errors.length === 1 && Arr.every(result.errors, isNotFound))
		}).pipe(Effect.provide(server.layer))
	})

	it.effect("returns GraphQL errors on a 400 as an answer, so not found can be told apart", () => {
		const server = linear([
			() =>
				VendorFake.json(
					{
						data: null,
						errors: [
							{
								message: "Could not find referenced Issue.",
								extensions: { code: "INPUT_ERROR" },
							},
						],
					},
					400,
				),
		])
		return Effect.gen(function* () {
			const result = yield* send(QUERY, "MapleIssue")
			assert.isTrue(result.errors.length === 1 && Arr.every(result.errors, isNotFound))
		}).pipe(Effect.provide(server.layer))
	})

	it.effect("fails a rejected token as revoked, whatever status carries it", () => {
		const server = linear([
			() =>
				VendorFake.json(
					{
						errors: [
							{
								message: "Authentication required, not authenticated",
								extensions: { code: "AUTHENTICATION_ERROR" },
							},
						],
					},
					400,
				),
		])
		return Effect.gen(function* () {
			const error = yield* send(QUERY, "MapleIssue").pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
		}).pipe(Effect.provide(server.layer))
	})
})
