import { Schema } from "effect"
import {
  HttpApiEndpoint,
  HttpApiError,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity
} from "effect/unstable/httpapi"
import { describe, expect, it } from "tstyche"

describe("HttpApiMiddleware", () => {
  describe("Service", () => {
    it("defaults error services to never", () => {
      class M extends HttpApiMiddleware.Service<M>()("Http/Logger") {}

      expect<HttpApiMiddleware.ErrorServicesEncode<M>>().type.toBe<never>()
      expect<HttpApiMiddleware.ErrorServicesDecode<M>>().type.toBe<never>()
    })

    it("error", () => {
      class M extends HttpApiMiddleware.Service<M>()("Http/Logger", {
        error: Schema.String
      }) {}
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.String
      }).middleware(M)
      expect(M.error).type.toBe<ReadonlySet<Schema.Top>>()
      expect<HttpApiEndpoint.MiddlewareError<typeof endpoint>>().type.toBe<string>()
      expect(M.security).type.toBe<never>()
    })

    it("preserves error services for status annotations used with pipe", () => {
      class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {}) {}
      class M extends HttpApiMiddleware.Service<M>()("Http/Logger", {
        error: NotFound.pipe(HttpApiSchema.status(404))
      }) {}

      expect<HttpApiMiddleware.ErrorServicesEncode<M>>().type.toBe<never>()
      expect<HttpApiMiddleware.ErrorServicesDecode<M>>().type.toBe<never>()
    })

    it("security", () => {
      class M extends HttpApiMiddleware.Service<M>()("M", {
        security: {
          cookie: HttpApiSecurity.apiKey({
            in: "cookie",
            key: "token"
          })
        }
      }) {}
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.String
      }).middleware(M)
      expect(M.error).type.toBe<ReadonlySet<Schema.Top>>()
      expect<HttpApiEndpoint.MiddlewareError<typeof endpoint>>().type.toBe<never>()
      expect(M.security).type.toBe<{ readonly cookie: HttpApiSecurity.ApiKey }>()
    })

    it("error + security", () => {
      class M extends HttpApiMiddleware.Service<M>()("Http/Logger", {
        error: Schema.String,
        security: {
          cookie: HttpApiSecurity.apiKey({
            in: "cookie",
            key: "token"
          })
        }
      }) {}
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.String
      }).middleware(M)
      expect(M.error).type.toBe<ReadonlySet<Schema.Top>>()
      expect<HttpApiEndpoint.MiddlewareError<typeof endpoint>>().type.toBe<string>()
      expect(M.security).type.toBe<{ readonly cookie: HttpApiSecurity.ApiKey }>()
    })

    it("error array", () => {
      class M extends HttpApiMiddleware.Service<M>()("Http/Auth", {
        error: [HttpApiError.UnauthorizedNoContent, HttpApiError.ForbiddenNoContent]
      }) {}
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.String
      }).middleware(M)
      expect(M.error).type.toBe<ReadonlySet<Schema.Top>>()
      expect<HttpApiEndpoint.MiddlewareError<typeof endpoint>>().type.toBe<
        HttpApiError.Unauthorized | HttpApiError.Forbidden
      >()
    })
  })
})
