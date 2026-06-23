import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { HttpClientRequest, HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSecurity } from "effect/unstable/httpapi"

const decode = (authorization: string, security: HttpApiSecurity.Http = HttpApiSecurity.bearer) =>
  HttpApiBuilder.securityDecode(security).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request("http://localhost/", { headers: { authorization } }))
    ),
    Effect.provideService(HttpServerRequest.ParsedSearchParams, {})
  )

describe("HttpApiSecurity", () => {
  describe("securityDecode", () => {
    it.effect("decodes a bearer token without a leading space", () =>
      Effect.gen(function*() {
        const token = "abc123"
        const { headers } = HttpClientRequest.get("http://localhost/").pipe(
          HttpClientRequest.bearerToken(token)
        )
        const credential = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request("http://localhost/", { headers }))
          ),
          Effect.provideService(HttpServerRequest.ParsedSearchParams, {})
        )

        assert.strictEqual(Redacted.value(credential), token)
      }))

    it.effect("decodes a custom http scheme without a leading space", () =>
      Effect.gen(function*() {
        const credential = yield* decode("Token abc123", HttpApiSecurity.http({ scheme: "Token" }))

        assert.strictEqual(Redacted.value(credential), "abc123")
      }))
  })
})
