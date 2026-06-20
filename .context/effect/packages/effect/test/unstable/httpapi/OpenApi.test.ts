import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

describe("OpenApi", () => {
  it("emits buffered and stream successes with the same status", () => {
    const Api = HttpApi.make("Api").add(
      HttpApiGroup.make("test").add(
        HttpApiEndpoint.get("chat", "/chat", {
          success: [
            Schema.Struct({ message: Schema.String }),
            HttpApiSchema.StreamSse({
              events: Schema.Struct({ event: Schema.String, data: Schema.String }),
              error: Schema.Struct({ reason: Schema.String })
            })
          ]
        })
      )
    )

    const spec = OpenApi.fromApi(Api)
    const content = spec.paths["/chat"]?.get?.responses[200]?.content

    assert.isNotNull(content)
    assert.property(content, "application/json")
    assert.property(content, "text/event-stream")
    const streamExtension = content?.["text/event-stream"]?.["x-effect-stream"]
    assert.isNotNull(streamExtension)
    if (streamExtension?.encoding !== "sse") {
      throw new Error("Expected SSE stream extension")
    }
    assert.strictEqual(
      streamExtension.failureEvent,
      "effect/httpapi/stream/failure"
    )
    assert.property(streamExtension, "causeSchema")
    assert.property(streamExtension, "errorSchema")
  })
})
