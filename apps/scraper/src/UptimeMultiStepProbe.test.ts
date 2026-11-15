import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { UptimeMultiStepConfig } from "@maple/domain/uptime"
import { HostResolver } from "@maple/safe-fetch/dns"
import { type RecordedRequest, stubFetch } from "./testing/stub-fetch"
import { fixedResolver } from "./testing/uptime"
import { UptimeHttpProbe } from "./UptimeHttpProbe"
import { UptimeMultiStepProbe } from "./UptimeMultiStepProbe"

const ProbeLive = UptimeMultiStepProbe.layer.pipe(
	Layer.provide(UptimeHttpProbe.layer),
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(
		Layer.succeed(
			HostResolver,
			fixedResolver(
				new Map([
					["api.example.com", ["93.184.216.34"]],
					["inside.example.com", ["10.0.0.7"]],
				]),
			),
		),
	),
)

const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" }
const decodeConfig = Schema.decodeUnknownSync(UptimeMultiStepConfig)

const step = (name: string, url: string, overrides: Record<string, unknown> = {}) => ({
	name,
	method: "GET",
	url,
	headers: {},
	assertions: [],
	extract: [],
	...overrides,
})

const LOGIN_THEN_ORDERS = decodeConfig({
	_tag: "multistep",
	timeoutMs: 30_000,
	steps: [
		step("Log in", "https://api.example.com/login", {
			method: "POST",
			body: '{"user":"probe"}',
			headers: { "content-type": "application/json" },
			extract: [
				{ name: "token", from: { _tag: "json_path", path: "session.token" } },
				{ name: "region", from: { _tag: "header", name: "X-Region" } },
			],
		}),
		step("List orders", "https://api.example.com/orders?region={{region}}", {
			headers: { authorization: "Bearer {{token}}" },
			assertions: [{ _tag: "body", op: "contains", value: "orders" }],
		}),
	],
})

const run = (
	config: typeof LOGIN_THEN_ORDERS,
	recorded: Array<RecordedRequest>,
	respond: Parameters<typeof stubFetch>[1],
) =>
	Effect.gen(function* () {
		const probe = yield* UptimeMultiStepProbe
		return yield* probe.probe(config, TRACE)
	}).pipe(Effect.provideService(FetchHttpClient.Fetch, stubFetch(recorded, respond)))

describe("UptimeMultiStepProbe", () => {
	it.effect("carries extracted values into later steps, each under its own child span id", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const outcome = yield* run(LOGIN_THEN_ORDERS, recorded, (request) =>
				Str.endsWith("/login")(request.url)
					? new Response('{"session":{"token":"t-123"}}', {
							status: 200,
							headers: { "x-region": "eu" },
						})
					: new Response('{"orders":[]}', { status: 200 }),
			)
			assert.deepStrictEqual(
				{ ok: outcome.ok, statusCode: outcome.statusCode, error: outcome.error },
				{ ok: true, statusCode: 200, error: null },
			)
			const [login, orders] = recorded
			assert.strictEqual(login?.method, "POST")
			assert.strictEqual(login?.body, '{"user":"probe"}')
			assert.strictEqual(orders?.url, "https://93.184.216.34/orders?region=eu")
			assert.strictEqual(orders?.headers.authorization, "Bearer t-123")
			const steps = outcome.steps ?? []
			assert.deepStrictEqual(
				Arr.map(steps, (run) => [run.name, run.outcome.ok]),
				[
					["Log in", true],
					["List orders", true],
				],
			)
			// Each request's traceparent is its step's span, in the check's trace.
			assert.deepStrictEqual(
				Arr.map(recorded, (request) => request.headers.traceparent),
				Arr.map(steps, (run) => `00-${TRACE.traceId}-${run.spanId}-01`),
			)
			assert.notStrictEqual(steps[0]?.spanId, steps[1]?.spanId)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("stops at the first failing step and names it in the check's error", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const config = decodeConfig({
				...LOGIN_THEN_ORDERS,
				steps: [...LOGIN_THEN_ORDERS.steps, step("Never runs", "https://api.example.com/after")],
			})
			const outcome = yield* run(config, recorded, (request) =>
				Str.endsWith("/login")(request.url)
					? new Response('{"session":{"token":"t-123"}}', {
							status: 200,
							headers: { "x-region": "eu" },
						})
					: new Response("boom", { status: 500 }),
			)
			assert.deepStrictEqual(
				{
					ok: outcome.ok,
					statusCode: outcome.statusCode,
					error: outcome.error,
					type: outcome.errorType,
				},
				{
					ok: false,
					statusCode: 500,
					error: "Step 2 (List orders): Status 500, expected 2xx",
					type: "assertion",
				},
			)
			assert.strictEqual(recorded.length, 2)
			assert.strictEqual(outcome.steps?.length, 2)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("fails the step whose extraction finds nothing, before the next one sends a blank", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const outcome = yield* run(
				LOGIN_THEN_ORDERS,
				recorded,
				() => new Response('{"session":{}}', { status: 200, headers: { "x-region": "eu" } }),
			)
			assert.strictEqual(
				outcome.error,
				"Step 1 (Log in): JSON path session.token not found, so token could not be set",
			)
			assert.strictEqual(recorded.length, 1)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("refuses a step whose interpolated URL reaches a private address", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const config = decodeConfig({
				_tag: "multistep",
				timeoutMs: 30_000,
				steps: [
					step("Discover", "https://api.example.com/discover", {
						extract: [{ name: "next", from: { _tag: "json_path", path: "next" } }],
					}),
					step("Follow", "{{next}}"),
				],
			})
			const outcome = yield* run(
				config,
				recorded,
				() => new Response('{"next":"https://inside.example.com/admin"}', { status: 200 }),
			)
			assert.strictEqual(outcome.errorType, "ssrf_refused")
			assert.match(outcome.error ?? "", /^Step 2 \(Follow\): Refused to connect/u)
			// The private host was never dialled.
			assert.strictEqual(recorded.length, 1)
		}).pipe(Effect.provide(ProbeLive)),
	)
})
