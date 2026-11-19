import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Exit, Layer, Option, Redacted, String as Str } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { makeRecordingTracer } from "@maple/backend/testing/recording-tracer"
import { ORG_A } from "@maple/backend/testing/test-two-orgs"
import { WarehouseDeleteToken } from "@maple/infra/secrets"
import { orgDeleteCondition, WarehouseDeleteClient } from "./WarehouseDeleteClient"

interface Sent {
	readonly method: string
	readonly url: string
	readonly authorization: string | undefined
	readonly body: string
}

/** A warehouse answering each request with `answer(url)`; records what it was sent. */
const warehouse = (answer: (url: string) => { readonly status: number; readonly body: unknown }) => {
	const sent: Array<Sent> = []
	const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			sent.push({
				method: request.method,
				url: request.url,
				authorization: request.headers["authorization"],
				body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
			})
			const { status, body } = answer(request.url)
			return HttpClientResponse.fromWeb(
				request,
				new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				}),
			)
		}),
	)
	return { sent, client }
}

const clientLayer = (http: HttpClient.HttpClient, token: Option.Option<string>) =>
	Layer.effect(WarehouseDeleteClient, WarehouseDeleteClient.make).pipe(
		Layer.provide([
			Layer.succeed(HttpClient.HttpClient, http),
			Layer.succeed(
				WarehouseDeleteToken,
				Option.map(token, (value) => Redacted.make(value)),
			),
			ConfigProvider.layer(ConfigProvider.fromUnknown({ TINYBIRD_HOST: "https://warehouse.test/" })),
		]),
	)

describe("WarehouseDeleteClient", () => {
	it.effect("starts a delete job for the org's rows with the delete token, then reads its state", () => {
		const fake = warehouse((url) =>
			Str.endsWith("/delete")(url)
				? { status: 200, body: { job_id: "job-1", job_url: "https://warehouse.test/v0/jobs/job-1" } }
				: { status: 200, body: { status: "working" } },
		)
		return Effect.gen(function* () {
			const client = yield* WarehouseDeleteClient
			assert.strictEqual(yield* client.submit("traces", ORG_A), "job-1")
			assert.deepStrictEqual(yield* client.status("job-1"), { _tag: "Pending" })

			const [submit, poll] = fake.sent
			assert.strictEqual(submit?.method, "POST")
			assert.strictEqual(submit?.url, "https://warehouse.test/v0/datasources/traces/delete")
			assert.strictEqual(submit?.authorization, "Bearer delete-token")
			assert.strictEqual(
				new URLSearchParams(submit?.body).get("delete_condition"),
				`OrgId = '${ORG_A}'`,
			)
			assert.strictEqual(poll?.url, "https://warehouse.test/v0/jobs/job-1")
		}).pipe(Effect.provide(clientLayer(fake.client, Option.some("delete-token"))))
	})

	it.effect("names the warehouse as the peer on its client spans", () => {
		const fake = warehouse((url) =>
			Str.endsWith("/delete")(url)
				? { status: 200, body: { job_id: "job-1" } }
				: { status: 200, body: { status: "done" } },
		)
		const { spans, tracer } = makeRecordingTracer()
		return Effect.gen(function* () {
			const client = yield* WarehouseDeleteClient
			yield* client.submit("traces", ORG_A)
			yield* client.status("job-1")
			const peers = Arr.map(
				Arr.filter(spans, (span) => Str.startsWith("WarehouseDeleteClient.")(span.name)),
				(span) => [span.name, span.attributes.get("peer.service")] as const,
			)
			assert.deepStrictEqual(peers, [
				["WarehouseDeleteClient.submit", "tinybird"],
				["WarehouseDeleteClient.status", "tinybird"],
			])
		}).pipe(
			Effect.withTracer(tracer),
			Effect.provide(clientLayer(fake.client, Option.some("delete-token"))),
		)
	})

	it.effect("reads a finished job as done and an errored one as failed with its reason", () => {
		const fake = warehouse((url) =>
			Str.endsWith("/done")(url)
				? { status: 200, body: { status: "done" } }
				: { status: 200, body: { status: "error", error: "too many parts" } },
		)
		return Effect.gen(function* () {
			const client = yield* WarehouseDeleteClient
			assert.deepStrictEqual(yield* client.status("done"), { _tag: "Done" })
			assert.deepStrictEqual(yield* client.status("broken"), {
				_tag: "Failed",
				message: 'Delete job ended "error": too many parts',
			})
		}).pipe(Effect.provide(clientLayer(fake.client, Option.some("delete-token"))))
	})

	it.effect("fails with the warehouse's answer on a refused request", () => {
		const fake = warehouse(() => ({ status: 403, body: { error: "forbidden" } }))
		return Effect.gen(function* () {
			const client = yield* WarehouseDeleteClient
			const exit = yield* Effect.exit(client.submit("traces", ORG_A))
			assert.isTrue(Exit.isFailure(exit))
			assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "Warehouse answered 403")
		}).pipe(Effect.provide(clientLayer(fake.client, Option.some("delete-token"))))
	})

	it.effect("sends nothing while the delete token is not provisioned", () => {
		const fake = warehouse(() => ({ status: 200, body: { job_id: "job-1" } }))
		return Effect.gen(function* () {
			const client = yield* WarehouseDeleteClient
			const exit = yield* Effect.exit(client.submit("traces", ORG_A))
			assert.isTrue(Exit.isFailure(exit))
			assert.deepStrictEqual(fake.sent, [])
		}).pipe(Effect.provide(clientLayer(fake.client, Option.none())))
	})

	it.effect("sends nothing for a datasource or org id that is not a plain identifier", () => {
		const fake = warehouse(() => ({ status: 200, body: { job_id: "job-1" } }))
		return Effect.gen(function* () {
			const client = yield* WarehouseDeleteClient
			assert.isTrue(Exit.isFailure(yield* Effect.exit(client.submit("traces/../x", ORG_A))))
			assert.deepStrictEqual(fake.sent, [])
			assert.isTrue(Option.isNone(orgDeleteCondition("org' OR 1=1 --")))
		}).pipe(Effect.provide(clientLayer(fake.client, Option.some("delete-token"))))
	})
})
