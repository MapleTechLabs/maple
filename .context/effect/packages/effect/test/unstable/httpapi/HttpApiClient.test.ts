import { assert, describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Cause, Effect, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

describe("HttpApiClient", () => {
  describe("streaming responses", () => {
    it.effect("decodes StreamSse events incrementally", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(
              textStream([
                "event: first\ndata: one\n\n",
                "event: second\ndata: two\n\n"
              ]),
              { status: 200 }
            )
          )
        })

        const stream = yield* client.test.events({})
        const first = yield* stream.pipe(Stream.take(1), Stream.runCollect)
        assert.deepStrictEqual(first, [{ event: "first", data: "one" }])
      }))

    it.effect("decodes StreamSse reserved failure events as full causes", () =>
      Effect.gen(function*() {
        const expectedCause = Cause.fail({ reason: "boom" })
        const FailureSchema = Schema.toCodecJson(Schema.Cause(StreamError, Schema.Defect()))
        const encodeCause = Schema.encodeUnknownEffect(Schema.fromJsonString(FailureSchema))
        const encodedCause = yield* encodeCause(expectedCause)
        const failureEvent = Sse.encoder.write({
          _tag: "Event",
          event: "effect/httpapi/stream/failure",
          id: undefined,
          data: encodedCause
        })

        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() => new Response(textStream([failureEvent]), { status: 200 }))
        })

        const stream = yield* client.test.events({})
        const exit = yield* Effect.exit(Stream.runCollect(stream))

        assert.strictEqual(exit._tag, "Failure")
        if (exit._tag === "Failure") {
          assert.deepStrictEqual(exit.cause, expectedCause)
        }
      }))

    it.effect("returns StreamUint8Array response bytes incrementally", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(byteStream([new Uint8Array([1, 2]), new Uint8Array([3])]), { status: 200 })
          )
        })

        const stream = yield* client.test.download({})
        const first = yield* stream.pipe(Stream.take(1), Stream.runCollect)
        assert.deepStrictEqual(first.map((chunk) => Array.from(chunk)), [[1, 2]])
      }))

    it.effect("decodes StreamSse successes at the annotated status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(AnnotatedStreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(textStream(["event: annotated\ndata: ok\n\n"]), { status: 202 })
          )
        })

        const stream = yield* client.test.events({})
        const events = yield* Stream.runCollect(stream)
        assert.deepStrictEqual(events, [{ event: "annotated", data: "ok" }])
      }))

    it.effect("decodes StreamUint8Array successes at the annotated status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(AnnotatedStreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() => new Response(byteStream([new Uint8Array([4, 5])]), { status: 206 }))
        })

        const stream = yield* client.test.download({})
        const chunks = yield* Stream.runCollect(stream)
        assert.deepStrictEqual(chunks.map((chunk) => Array.from(chunk)), [[4, 5]])
      }))

    it.effect("decodes non-success responses through endpoint error schemas before returning a stream", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(JSON.stringify({ _tag: "EndpointError", message: "bad request" }), {
              status: 400,
              headers: { "content-type": "application/json" }
            })
          )
        })

        const error = yield* Effect.flip(client.test.events({}))
        assert.deepStrictEqual(error, new EndpointError({ message: "bad request" }))
      }))

    it.effect("preserves response-only raw response stream access", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(
              byteStream([
                new Uint8Array([1]),
                new Uint8Array([2, 3])
              ]),
              { status: 200 }
            )
          )
        })

        const response = yield* client.test.download({ responseMode: "response-only" })
        const chunks = yield* Stream.runCollect(response.stream)
        assert.deepStrictEqual(chunks.map((chunk) => Array.from(chunk)), [[1], [2, 3]])
      }))

    it.effect("selects a buffered response by content type when a stream uses the same status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(MixedSuccessApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(JSON.stringify({ message: "done" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          )
        })

        const response = yield* client.test.chat({})
        assert.deepStrictEqual(response, { message: "done" })
      }))

    it.effect("selects a stream response by content type when buffered success uses the same status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(MixedSuccessApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(textStream([`event: token\ndata: {"text":"hello"}\n\n`]), {
              status: 200,
              headers: { "content-type": "text/event-stream; charset=utf-8" }
            })
          )
        })

        const stream = yield* client.test.chat({})
        if (!Stream.isStream(stream)) {
          throw new Error("Expected stream response")
        }
        const events = yield* Stream.runCollect(stream)
        assert.deepStrictEqual(events, [{ text: "hello" }])
      }))
  })

  describe("urlBuilder", () => {
    const Api = HttpApi.make("Api")
      .add(
        HttpApiGroup.make("users")
          .add(
            HttpApiEndpoint.get("getUser", "/users/:id", {
              params: {
                id: Schema.Finite
              },
              query: {
                page: Schema.Finite,
                tags: Schema.Array(Schema.Finite)
              }
            }),
            HttpApiEndpoint.get("health", "/health")
          )
      )

    it("builds urls using endpoint schemas", () => {
      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(
        builder.users.getUser({
          params: {
            id: 123
          },
          query: {
            page: 1,
            tags: [1, 2]
          }
        }),
        "https://api.example.com/users/123?page=1&tags=1&tags=2"
      )
    })

    it("encodes path parameters", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("stacks")
            .add(
              HttpApiEndpoint.get("listResources", "/state/stacks/:stack/stages/:stage/resources", {
                params: {
                  stack: Schema.String,
                  stage: Schema.String
                }
              })
            )
        )
      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(
        builder.stacks.listResources({
          params: {
            stack: "a/b",
            stage: "prod/blue"
          }
        }),
        "https://api.example.com/state/stacks/a%2Fb/stages/prod%2Fblue/resources"
      )
    })

    it("omits missing optional path parameters", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("files")
            .add(
              HttpApiEndpoint.get("download", "/files/:path?", {
                params: {
                  path: Schema.optional(Schema.String)
                }
              })
            )
        )
      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(
        builder.files.download({ params: {} }),
        "https://api.example.com/files"
      )
      strictEqual(
        builder.files.download({ params: { path: "a/b" } }),
        "https://api.example.com/files/a%2Fb"
      )
    })

    it("returns relative urls when baseUrl is omitted", () => {
      const builder = HttpApiClient.urlBuilder(Api)

      strictEqual(builder.users.health(), "/health")
    })

    it("supports top-level endpoints", () => {
      const TopLevelApi = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("top", { topLevel: true })
            .add(
              HttpApiEndpoint.get("health", "/health")
            )
        )
        .prefix("/v1")

      const builder = HttpApiClient.urlBuilder(TopLevelApi, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(builder.health(), "https://api.example.com/v1/health")
    })
  })

  it.effect("encodes path parameters when executing requests", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("stacks")
            .add(
              HttpApiEndpoint.get("listResources", "/state/stacks/:stack/stages/:stage/resources", {
                params: {
                  stack: Schema.String,
                  stage: Schema.String
                }
              })
            )
        )
      const httpClient = HttpClient.make((request, url) =>
        Effect.sync(() => {
          strictEqual(url.toString(), "https://api.example.com/state/stacks/a%2Fb/stages/prod%2Fblue/resources")
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
        })
      )
      const client = yield* HttpApiClient.makeWith(Api, {
        httpClient,
        baseUrl: "https://api.example.com"
      })

      yield* client.stacks.listResources({
        params: {
          stack: "a/b",
          stage: "prod/blue"
        },
        responseMode: "response-only"
      })
    }))

  it.effect("omits optional path parameters when executing requests", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("files")
            .add(
              HttpApiEndpoint.get("download", "/files/:path?", {
                params: {
                  path: Schema.optional(Schema.String)
                }
              })
            )
        )
      const urls: Array<string> = []
      const httpClient = HttpClient.make((request, url) =>
        Effect.sync(() => {
          urls.push(url.toString())
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
        })
      )
      const client = yield* HttpApiClient.makeWith(Api, {
        httpClient,
        baseUrl: "https://api.example.com"
      })

      yield* client.files.download({
        params: {},
        responseMode: "response-only"
      })
      yield* client.files.download({
        params: { path: "a/b" },
        responseMode: "response-only"
      })

      strictEqual(urls[0], "https://api.example.com/files")
      strictEqual(urls[1], "https://api.example.com/files/a%2Fb")
    }))
})

const textEncoder = new TextEncoder()

const StreamError = Schema.Struct({ reason: Schema.String })

const Events = Schema.Struct({
  event: Schema.String,
  data: Schema.String
})

class EndpointError extends Schema.TaggedErrorClass<EndpointError>()("EndpointError", {
  message: Schema.String
}, { httpApiStatus: 400 }) {}

const MixedSuccess = Schema.Struct({
  message: Schema.String
})

const MixedEventData = Schema.Struct({
  text: Schema.String
})

const StreamingApi = HttpApi.make("StreamingApi").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("events", "/events", {
        success: HttpApiSchema.StreamSse({ events: Events, error: StreamError }),
        error: EndpointError
      }),
      HttpApiEndpoint.get("download", "/download", {
        success: HttpApiSchema.StreamUint8Array(),
        error: EndpointError
      })
    )
)

const AnnotatedStreamingApi = HttpApi.make("AnnotatedStreamingApi").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("events", "/events", {
        success: HttpApiSchema.status(202)(HttpApiSchema.StreamSse({ events: Events, error: StreamError }))
      }),
      HttpApiEndpoint.get("download", "/download", {
        success: HttpApiSchema.status(206)(HttpApiSchema.StreamUint8Array())
      })
    )
)

const MixedSuccessApi = HttpApi.make("MixedSuccessApi").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("chat", "/chat", {
        success: [
          MixedSuccess,
          HttpApiSchema.StreamSse({ data: MixedEventData, error: StreamError })
        ]
      })
    )
)

const clientFromResponse = (response: () => Response): HttpClient.HttpClient =>
  HttpClient.make((request): Effect.Effect<HttpClientResponse.HttpClientResponse, never, never> =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response()))
  )

const textStream = (chunks: ReadonlyArray<string>): ReadableStream<Uint8Array> => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close()
      } else {
        controller.enqueue(textEncoder.encode(chunks[index++]!))
      }
    }
  })
}

const byteStream = (chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close()
      } else {
        controller.enqueue(chunks[index++]!)
      }
    }
  })
}
