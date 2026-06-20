import { type Effect, hole, Schema, type Stream, Struct } from "effect"
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse"
import { HttpApiEndpoint, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { describe, expect, it } from "tstyche"

describe("HttpApiEndpoint", () => {
  describe("params option", () => {
    it("should default to never", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      expect(endpoint["~Params"]).type.toBe<HttpApiEndpoint.StringTree<never>>()
    })

    it("should accept a record of fields", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        params: {
          id: Schema.Finite
        }
      })
      expect(endpoint["~Params"]).type.toBe<
        HttpApiEndpoint.StringTree<
          Schema.Struct<{ id: Schema.Finite }>
        >
      >()
    })

    it("should accept a Struct", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        params: Schema.Struct({ a: Schema.Finite, b: Schema.Finite })
      })
      expect(endpoint["~Params"]).type.toBe<
        HttpApiEndpoint.StringTree<
          Schema.Struct<{ readonly a: Schema.Finite; readonly b: Schema.Finite }>
        >
      >()
    })
  })

  describe("query option", () => {
    it("should default to never", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      expect(endpoint["~Query"]).type.toBe<HttpApiEndpoint.StringTree<never>>()
    })

    it("should accept a record of fields", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        query: {
          id: Schema.Finite
        }
      })
      expect(endpoint["~Query"]).type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.Finite }>>>()
    })

    it("should accept a Struct.Record", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        query: Struct.Record(["a", "b"], Schema.Finite)
      })
      expect(endpoint["~Query"]).type.toBe<
        HttpApiEndpoint.StringTree<Schema.Struct<{ a: Schema.Finite; b: Schema.Finite }>>
      >()
    })

    it("should accept a Struct", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        query: Schema.Struct({ a: Schema.Finite, b: Schema.Finite })
      })
      expect(endpoint["~Query"]).type.toBe<
        HttpApiEndpoint.StringTree<
          Schema.Struct<{ readonly a: Schema.Finite; readonly b: Schema.Finite }>
        >
      >()
    })
  })

  describe("headers option", () => {
    it("should default to never", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      expect(endpoint["~Headers"]).type.toBe<HttpApiEndpoint.StringTree<never>>()
    })

    it("should accept a record of fields", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        headers: {
          id: Schema.FiniteFromString
        }
      })
      expect(endpoint["~Headers"]).type.toBe<
        HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.FiniteFromString }>>
      >()
    })

    it("should accept a Struct", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        headers: Schema.Struct({ a: Schema.FiniteFromString, b: Schema.FiniteFromString })
      })
      expect(endpoint["~Headers"]).type.toBe<
        HttpApiEndpoint.StringTree<
          Schema.Struct<{ readonly a: Schema.FiniteFromString; readonly b: Schema.FiniteFromString }>
        >
      >()
    })
  })

  describe("payload option", () => {
    it("should default to never", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      expect(endpoint["~Payload"]).type.toBe<HttpApiEndpoint.StringTree<never>>()
    })

    describe("GET", () => {
      it("should accept a record of fields", () => {
        const endpoint = HttpApiEndpoint.get("a", "/a", {
          payload: {
            id: Schema.Finite
          }
        })
        expect(endpoint["~Payload"]).type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.Finite }>>>()
      })

      it("should not accept any other schema", () => {
        expect(HttpApiEndpoint.get).type.not.toBeCallableWith("a", "/a", {
          payload: Schema.Struct({ id: Schema.String })
        })
      })
    })

    describe("POST", () => {
      it("should accept a schema", () => {
        const endpoint = HttpApiEndpoint.post("a", "/a", {
          payload: Schema.Struct({ a: Schema.String })
        })
        expect(endpoint["~Payload"]).type.toBe<HttpApiEndpoint.Json<Schema.Struct<{ readonly a: Schema.String }>>>()
      })

      it("should accept an array of schemas", () => {
        const endpoint = HttpApiEndpoint.post("a", "/a", {
          payload: [
            Schema.Struct({ a: Schema.String }), // application/json
            Schema.String.pipe(HttpApiSchema.asText()), // text/plain
            Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()) // application/octet-stream
          ]
        })
        expect(endpoint["~Payload"]).type.toBe<
          HttpApiEndpoint.Json<
            Schema.String | Schema.Struct<{ readonly a: Schema.String }> | Schema.Uint8Array
          >
        >()
      })
    })

    describe("HEAD", () => {
      it("should accept a record of fields", () => {
        const endpoint = HttpApiEndpoint.head("a", "/a", {
          payload: {
            id: Schema.Finite
          }
        })
        expect(endpoint["~Payload"]).type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.Finite }>>>()
      })

      it("should not accept any other schema", () => {
        expect(HttpApiEndpoint.head).type.not.toBeCallableWith("a", "/a", {
          payload: Schema.Struct({ id: Schema.String })
        })
      })
    })

    describe("OPTIONS", () => {
      it("should accept a record of fields", () => {
        const endpoint = HttpApiEndpoint.options("a", "/a", {
          payload: {
            id: Schema.Finite
          }
        })
        expect(endpoint["~Payload"]).type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.Finite }>>>()
      })

      it("should not accept any other schema", () => {
        expect(HttpApiEndpoint.options).type.not.toBeCallableWith("a", "/a", {
          payload: Schema.Struct({ id: Schema.String })
        })
      })
    })
  })

  describe("success option", () => {
    it("should default to HttpApiSchema.NoContent", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      expect(endpoint["~Success"]).type.toBe<HttpApiEndpoint.Json<typeof HttpApiSchema.NoContent>>()
    })

    it("should accept a schema", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.Struct({ a: Schema.String })
      })
      expect(endpoint["~Success"]).type.toBe<HttpApiEndpoint.Json<Schema.Struct<{ readonly a: Schema.String }>>>()
    })

    it("should accept an array of schemas", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: [
          Schema.Struct({ a: Schema.String }), // application/json
          Schema.String.pipe(HttpApiSchema.asText()), // text/plain
          Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()) // application/octet-stream
        ]
      })
      expect(endpoint["~Success"]).type.toBe<
        HttpApiEndpoint.Json<Schema.String | Schema.Struct<{ readonly a: Schema.String }> | Schema.Uint8Array>
      >()
    })

    it("should accept StreamSse", () => {
      const stream = HttpApiSchema.StreamSse({
        events: Schema.Struct({
          event: Schema.Literal("user.created"),
          data: Schema.String
        }),
        error: Schema.Struct({ reason: Schema.String })
      })
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: stream
      })
      expect(endpoint["~Success"]).type.toBe<typeof stream>()
    })

    it("should map StreamSse to stream success helper and handler types", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: HttpApiSchema.StreamSse({
          events: Schema.Struct({
            event: Schema.Literal("user.created"),
            data: Schema.String
          }),
          error: Schema.Struct({ reason: Schema.String })
        })
      })

      type Event = { readonly event: "user.created"; readonly data: string }
      type StreamError = { readonly reason: string }
      type Success = Stream.Stream<Event, StreamError>

      expect<HttpApiEndpoint.SuccessWithName<typeof endpoint, "a">>().type.toBe<Success>()
      expect<ReturnType<HttpApiEndpoint.Handler<typeof endpoint, never, never>>>().type.toBe<
        Effect.Effect<Success | HttpServerResponse, never>
      >()
      expect<ReturnType<HttpApiEndpoint.HandlerRaw<typeof endpoint, never, never>>>().type.toBe<
        Effect.Effect<Success | HttpServerResponse, never>
      >()
    })

    it("should map StreamSse data mode to data stream helper and handler types", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: HttpApiSchema.StreamSse({
          data: Schema.Struct({ id: Schema.String }),
          error: Schema.Struct({ reason: Schema.String })
        })
      })

      type Data = { readonly id: string }
      type StreamError = { readonly reason: string }
      type Success = Stream.Stream<Data, StreamError>

      expect<HttpApiEndpoint.SuccessWithName<typeof endpoint, "a">>().type.toBe<Success>()
      expect<ReturnType<HttpApiEndpoint.Handler<typeof endpoint, never, never>>>().type.toBe<
        Effect.Effect<Success | HttpServerResponse, never>
      >()
    })

    it("should map StreamSse without error schema to never stream errors", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: HttpApiSchema.StreamSse({
          data: Schema.Struct({ id: Schema.String })
        })
      })

      type Data = { readonly id: string }
      type Success = Stream.Stream<Data, never>

      expect<HttpApiEndpoint.SuccessWithName<typeof endpoint, "a">>().type.toBe<Success>()
      expect<ReturnType<HttpApiEndpoint.Handler<typeof endpoint, never, never>>>().type.toBe<
        Effect.Effect<Success | HttpServerResponse, never>
      >()
    })

    it("should accept StreamUint8Array", () => {
      const stream = HttpApiSchema.StreamUint8Array()
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: stream
      })
      expect(endpoint["~Success"]).type.toBe<typeof stream>()
    })

    it("should map StreamUint8Array to stream success helper and handler types", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: HttpApiSchema.StreamUint8Array()
      })

      type Success = Stream.Stream<Uint8Array, unknown>

      expect<HttpApiEndpoint.SuccessWithName<typeof endpoint, "a">>().type.toBe<Success>()
      expect<ReturnType<HttpApiEndpoint.Handler<typeof endpoint, never, never>>>().type.toBe<
        Effect.Effect<Success | HttpServerResponse, never>
      >()
      expect<ReturnType<HttpApiEndpoint.HandlerRaw<typeof endpoint, never, never>>>().type.toBe<
        Effect.Effect<Success | HttpServerResponse, never>
      >()
    })

    it("should include StreamSse event and error schema services", () => {
      type Event = { readonly event: "user.created"; readonly data: string }
      type StreamError = { readonly reason: string }

      const Events = hole<Schema.Codec<Event, Event, "EventsDecoding", "EventsEncoding">>()
      const Error = hole<Schema.Codec<StreamError, StreamError, "ErrorDecoding", "ErrorEncoding">>()
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: HttpApiSchema.StreamSse({ events: Events, error: Error })
      })

      expect<HttpApiEndpoint.ServerServices<typeof endpoint>>().type.toBe<"EventsEncoding" | "ErrorEncoding">()
      expect<HttpApiEndpoint.ClientServices<typeof endpoint>>().type.toBe<"EventsDecoding" | "ErrorDecoding">()
    })
  })

  describe("error option", () => {
    it("should accept a schema", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        error: Schema.Struct({ a: Schema.String })
      })
      expect(endpoint["~Error"]).type.toBe<
        HttpApiEndpoint.Json<
          Schema.Struct<{ readonly a: Schema.String }>
        >
      >()
    })

    it("should accept an array of schemas", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        error: [
          Schema.Struct({ a: Schema.String }), // application/json
          Schema.String.pipe(HttpApiSchema.asText()), // text/plain
          Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()) // application/octet-stream
        ]
      })
      expect(endpoint["~Error"]).type.toBe<
        HttpApiEndpoint.Json<
          | Schema.String
          | Schema.Struct<{ readonly a: Schema.String }>
          | Schema.Uint8Array
        >
      >()
    })

    it("should infer endpoint errors with mixed buffered and StreamSse success schemas", () => {
      const endpoint = HttpApiEndpoint.post("completions", "/completions", {
        payload: Schema.Struct({ prompt: Schema.String }),
        success: [
          Schema.Struct({ message: Schema.String }),
          HttpApiSchema.StreamSse({
            data: Schema.Struct({ token: Schema.String }),
            error: HttpApiError.InternalServerError
          })
        ],
        headers: {
          "x-session-affinity": Schema.optional(Schema.String)
        },
        error: [HttpApiError.BadRequest]
      })

      expect<HttpApiEndpoint.Errors<typeof endpoint>>().type.toBe<HttpApiError.BadRequest>()
    })

    it("should infer a single endpoint error with StreamSse success", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: HttpApiSchema.StreamSse({
          data: Schema.Struct({ token: Schema.String }),
          error: HttpApiError.InternalServerError
        }),
        error: HttpApiError.BadRequest
      })

      expect<HttpApiEndpoint.Errors<typeof endpoint>>().type.toBe<HttpApiError.BadRequest>()
    })

    it("should infer endpoint error arrays with StreamSse success", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: HttpApiSchema.StreamSse({
          data: Schema.Struct({ token: Schema.String }),
          error: HttpApiError.InternalServerError
        }),
        error: [HttpApiError.BadRequest, HttpApiError.Conflict]
      })

      expect<HttpApiEndpoint.Errors<typeof endpoint>>().type.toBe<
        HttpApiError.BadRequest | HttpApiError.Conflict
      >()
    })

    it("should infer endpoint error arrays with StreamSse first in a success array", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: [
          HttpApiSchema.StreamSse({
            data: Schema.Struct({ token: Schema.String }),
            error: HttpApiError.InternalServerError
          }),
          Schema.Struct({ message: Schema.String })
        ],
        error: [HttpApiError.BadRequest, HttpApiError.Conflict]
      })

      expect<HttpApiEndpoint.Errors<typeof endpoint>>().type.toBe<
        HttpApiError.BadRequest | HttpApiError.Conflict
      >()
    })

    it("should infer endpoint error arrays with StreamUint8Array success", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: HttpApiSchema.StreamUint8Array(),
        error: [HttpApiError.BadRequest, HttpApiError.Conflict]
      })

      expect<HttpApiEndpoint.Errors<typeof endpoint>>().type.toBe<
        HttpApiError.BadRequest | HttpApiError.Conflict
      >()
    })

    it("should infer endpoint errors with disableCodecs enabled", () => {
      const endpoint = HttpApiEndpoint.post("a", "/a", {
        disableCodecs: true,
        payload: Schema.Struct({ prompt: Schema.String }),
        success: [
          Schema.Struct({ message: Schema.String }),
          HttpApiSchema.StreamSse({
            data: Schema.Struct({ token: Schema.String }),
            error: HttpApiError.InternalServerError
          })
        ],
        error: [HttpApiError.BadRequest, HttpApiError.Conflict]
      })

      expect(endpoint["~Error"]).type.toBe<typeof HttpApiError.BadRequest | typeof HttpApiError.Conflict>()
      expect<(typeof endpoint)["~Error"]["Type"]>().type.toBe<
        HttpApiError.BadRequest | HttpApiError.Conflict
      >()
    })

    it("should not accept streaming schemas", () => {
      expect(HttpApiEndpoint.get).type.not.toBeCallableWith("a", "/a", {
        error: HttpApiSchema.StreamUint8Array()
      })
      expect(HttpApiEndpoint.get).type.not.toBeCallableWith("a", "/a", {
        error: HttpApiSchema.StreamSse({
          events: Schema.Struct({
            event: Schema.Literal("user.created"),
            data: Schema.String
          }),
          error: Schema.Struct({ reason: Schema.String })
        })
      })
      expect(HttpApiEndpoint.get).type.not.toBeCallableWith("a", "/a", {
        error: [Schema.String, HttpApiSchema.StreamUint8Array()]
      })
      expect(HttpApiEndpoint.get).type.not.toBeCallableWith("a", "/a", {
        disableCodecs: true,
        error: [Schema.String, HttpApiSchema.StreamUint8Array()]
      })
    })
  })
})
