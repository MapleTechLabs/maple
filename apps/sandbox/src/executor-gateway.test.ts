import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { type GatewayProps, NPM_UPSTREAM, gatewayFetch } from "./executor-gateway"
import { GATEWAY_MARKER } from "./executor-probe"

const TOKEN = "ghs_clone_token"
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const props: GatewayProps = { git: { remoteUrl: "https://github.com/octo/shop.git", token: TOKEN } }

/** A fake upstream that records what reached it and answers with `answer`. */
const upstream = (answer: (request: Request) => Response = () => new Response("ok")) => {
	const seen: Array<Request> = []
	return {
		seen,
		fetch: (request: Request) => {
			seen.push(request)
			return Promise.resolve(answer(request))
		},
	}
}

const call = (path: string, init: RequestInit = {}, gatewayProps: GatewayProps = props) => {
	const fake = upstream()
	return {
		fake,
		response: gatewayFetch(
			new Request(`http://registry.maple.internal${path}`, init),
			gatewayProps,
			fake.fetch,
		),
	}
}

describe("gatewayFetch", () => {
	it.effect("forwards a git fetch to the repository with the credential the container never sees", () =>
		Effect.gen(function* () {
			const { fake, response } = call("/git/info/refs?service=git-upload-pack", {
				headers: { "git-protocol": "version=2", cookie: "a=b" },
			})
			assert.strictEqual((yield* response).status, 200)
			const forwarded = fake.seen[0]
			assert.strictEqual(
				forwarded?.url,
				"https://github.com/octo/shop.git/info/refs?service=git-upload-pack",
			)
			assert.strictEqual(
				forwarded?.headers.get("authorization"),
				`Basic ${btoa(`x-access-token:${TOKEN}`)}`,
			)
			assert.strictEqual(forwarded?.headers.get("git-protocol"), "version=2")
			assert.isNull(forwarded?.headers.get("cookie"))
		}),
	)

	it.effect("allows the upload-pack POST and nothing that pushes", () =>
		Effect.gen(function* () {
			const pack = call("/git/git-upload-pack", { method: "POST", body: "0000" })
			assert.strictEqual((yield* pack.response).status, 200)
			assert.strictEqual(pack.fake.seen[0]?.url, "https://github.com/octo/shop.git/git-upload-pack")
			for (const [path, method] of [
				["/git/info/refs?service=git-receive-pack", "GET"],
				["/git/git-receive-pack", "POST"],
				["/git/../../other/repo.git/info/refs?service=git-upload-pack", "GET"],
			] as const) {
				const refused = call(path, { method, body: method === "POST" ? "0000" : null })
				assert.strictEqual((yield* refused.response).status, 403, path)
				assert.lengthOf(refused.fake.seen, 0)
			}
		}),
	)

	it.effect("refuses git when no repository is being prepared", () =>
		Effect.gen(function* () {
			const { fake, response } = call("/git/info/refs?service=git-upload-pack", {}, {})
			assert.strictEqual((yield* response).status, 403)
			assert.lengthOf(fake.seen, 0)
		}),
	)

	it.effect("reads npm and points tarball URLs in metadata back at the gateway", () =>
		Effect.gen(function* () {
			const fake = upstream(
				() =>
					new Response(
						encodeJson({ dist: { tarball: `${NPM_UPSTREAM}left-pad/-/left-pad-1.3.0.tgz` } }),
						{
							headers: { "content-type": "application/vnd.npm.install-v1+json" },
						},
					),
			)
			const response = yield* gatewayFetch(
				new Request("http://registry.maple.internal/npm/left-pad", {
					headers: {
						accept: "application/vnd.npm.install-v1+json",
						authorization: "Bearer stolen",
					},
				}),
				props,
				fake.fetch,
			)
			assert.strictEqual(fake.seen[0]?.url, `${NPM_UPSTREAM}left-pad`)
			assert.isNull(fake.seen[0]?.headers.get("authorization"))
			assert.include(
				yield* Effect.promise(() => response.text()),
				"http://registry.maple.internal/npm/left-pad/-/left-pad-1.3.0.tgz",
			)
		}),
	)

	it.effect("refuses writes to npm, odd package paths and any other host path", () =>
		Effect.gen(function* () {
			for (const [path, method] of [
				["/npm/left-pad", "PUT"],
				["/npm/-/user/org.couchdb.user:x", "POST"],
				["/npm/", "GET"],
				["/npm/a//b", "GET"],
				["/admin", "GET"],
			] as const) {
				const refused = call(path, { method, body: method === "GET" ? null : "{}" })
				const response = yield* refused.response
				assert.strictEqual(response.status, 403, `${method} ${path}`)
				assert.include(yield* Effect.promise(() => response.text()), GATEWAY_MARKER)
				assert.lengthOf(refused.fake.seen, 0)
			}
		}),
	)

	it.effect("answers 502 when the upstream does not", () =>
		Effect.gen(function* () {
			const response = yield* gatewayFetch(
				new Request("http://registry.maple.internal/npm/left-pad"),
				props,
				() => Promise.reject(new TypeError("network down")),
			)
			assert.strictEqual(response.status, 502)
		}),
	)

	it.effect("still answers the probe's marker", () =>
		Effect.gen(function* () {
			const response = yield* call("/probe", {}, {}).response
			assert.strictEqual(
				yield* Effect.promise(() => response.text()),
				`${GATEWAY_MARKER} GET registry.maple.internal/probe`,
			)
		}),
	)
})
