import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { discover, fetchEnvironmentMetrics } from "./api"

const RequestBody = Schema.fromJsonString(
	Schema.Struct({
		query: Schema.String,
		variables: Schema.Record(Schema.String, Schema.Unknown),
		operationName: Schema.String,
	}),
)
const decodeBody = Schema.decodeUnknownSync(RequestBody)

const PROBLEM = { data: null, errors: [{ message: "Problem processing request" }] }
const WORKSPACES = { data: { apiToken: { workspaces: [{ id: "ws_1", name: "Acme" }] } } }

const project = (id: string, environments: ReadonlyArray<{ id: string; isEphemeral?: boolean }>) => ({
	node: {
		id,
		name: id,
		environments: {
			edges: Arr.map(environments, (environment) => ({
				node: { name: environment.id, ...environment },
			})),
		},
		services: { edges: [{ node: { id: `svc_${id}`, name: "api" } }] },
	},
})

/** Answers each GraphQL operation by name; a missing name answers 404. */
const railway = (
	answers: Readonly<Record<string, (variables: Readonly<Record<string, unknown>>) => Response>>,
) =>
	VendorFake.make({
		routes: [
			{
				method: "POST",
				path: "/graphql/v2",
				respond: (request) => {
					const body = decodeBody(request.body)
					return answers[body.operationName]?.(body.variables)
				},
			},
		],
	})

const run = <A, E>(
	fake: VendorFake.VendorFake,
	effect: (client: HttpClient.HttpClient) => Effect.Effect<A, E>,
) =>
	Effect.flatMap(HttpClient.HttpClient, effect).pipe(
		Effect.provide(FetchHttpClient.layer.pipe(Layer.provideMerge(fake.layer))),
	)

const operations = (fake: VendorFake.VendorFake) =>
	Arr.map(fake.calls, (call) => decodeBody(call.body).operationName)

describe("Railway API access", () => {
	it.effect("discovers non-ephemeral environments across every page of projects", () =>
		Effect.gen(function* () {
			const fake = railway({
				TokenWorkspaces: () => VendorFake.json(WORKSPACES),
				WorkspaceProjects: (variables) =>
					variables["after"] === null
						? VendorFake.json({
								data: {
									projects: {
										edges: [
											project("p1", [
												{ id: "prod" },
												{ id: "pr-7", isEphemeral: true },
											]),
										],
										pageInfo: { hasNextPage: true, endCursor: "c1" },
									},
								},
							})
						: VendorFake.json({
								data: {
									projects: {
										edges: [project("p2", [{ id: "staging" }])],
										pageInfo: { hasNextPage: false, endCursor: null },
									},
								},
							}),
			})
			const discovery = yield* run(fake, (client) => discover(client, "token"))
			assert.deepStrictEqual(
				Arr.map(discovery.environments, (environment) => environment.environmentId),
				["prod", "staging"],
			)
			assert.deepStrictEqual(discovery.workspaceNames, ["Acme"])
			assert.strictEqual(fake.calls[0]?.authorization, "Bearer token")
			assert.deepStrictEqual(operations(fake), [
				"TokenWorkspaces",
				"WorkspaceProjects",
				"WorkspaceProjects",
			])
		}),
	)

	it.effect("retries Railway's transient 'Problem processing request' before failing", () =>
		Effect.gen(function* () {
			const fake = railway({ TokenWorkspaces: () => VendorFake.json(PROBLEM) })
			const error = yield* VendorFake.elapsing(
				Effect.flip(run(fake, (client) => discover(client, "token"))),
			)
			assert.strictEqual(error.kind, "upstream")
			assert.include(error.message, "Problem processing request")
			assert.lengthOf(fake.calls, 3)
		}),
	)

	it.effect("retries a 5xx on the read-only metrics query, though it is a POST", () =>
		Effect.gen(function* () {
			let attempts = 0
			const fake = railway({
				EnvironmentMetrics: () => {
					attempts += 1
					return attempts === 1
						? VendorFake.text("bad gateway", 502)
						: VendorFake.json({ data: { metrics: [] } })
				},
			})
			const metrics = yield* VendorFake.elapsing(
				run(fake, (client) =>
					fetchEnvironmentMetrics(client, "token", {
						environmentId: "env_1",
						startMs: 0,
						endMs: 60_000,
						sampleRateSeconds: 60,
					}),
				),
			)
			assert.deepStrictEqual(metrics, [])
			assert.lengthOf(fake.calls, 2)
		}),
	)

	it.effect("does not retry a rejected token", () =>
		Effect.gen(function* () {
			const fake = railway({
				TokenWorkspaces: () =>
					VendorFake.json({ data: null, errors: [{ message: "Not Authorized" }] }),
			})
			const error = yield* Effect.flip(run(fake, (client) => discover(client, "token")))
			assert.strictEqual(error.kind, "unauthorized")
			assert.lengthOf(fake.calls, 1)
		}),
	)

	it.effect("reads a rejected token from a 400 that carries GraphQL errors", () =>
		Effect.gen(function* () {
			const fake = railway({
				TokenWorkspaces: () =>
					VendorFake.json(
						{ errors: [{ message: "nope", extensions: { code: "UNAUTHENTICATED" } }] },
						400,
					),
			})
			const error = yield* Effect.flip(run(fake, (client) => discover(client, "token")))
			assert.strictEqual(error.kind, "unauthorized")
		}),
	)

	it.effect("reports a rate limit with its retry-after, without waiting out a long one", () =>
		Effect.gen(function* () {
			const fake = railway({
				TokenWorkspaces: () => VendorFake.text("slow down", 429, { "retry-after": "60" }),
			})
			const error = yield* Effect.flip(run(fake, (client) => discover(client, "token")))
			assert.strictEqual(error.kind, "rate_limited")
			assert.strictEqual(error.retryAfterSeconds, 60)
			assert.lengthOf(fake.calls, 1)
		}),
	)
})
