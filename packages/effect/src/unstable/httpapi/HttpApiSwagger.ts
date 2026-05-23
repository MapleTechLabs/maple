/**
 * Serves Swagger UI for an `HttpApi` by rendering the OpenAPI document generated
 * from the API directly into an HTML page.
 *
 * Use this module when you want a lightweight documentation route for a running
 * `HttpApi`, typically in development, staging, internal consoles, or public API
 * reference pages where Swagger UI's exploration and request-building tools are
 * preferred. The exported `layer` adds a `GET` route to an `HttpRouter`,
 * defaults the mount path to `/docs`, and leaves API implementation and server
 * wiring to `HttpApiBuilder` and the surrounding router layers.
 *
 * The page is self-contained: `OpenApi.fromApi` derives the specification from
 * the API's groups, endpoints, schemas, and OpenAPI annotations, then the JSON
 * is embedded into the HTML served to the browser. No separate `/openapi.json`
 * endpoint is installed by this module, so clients or documentation pipelines
 * that need the raw spec should use `OpenApi.fromApi` directly or expose a JSON
 * route elsewhere. If the docs are public, mount the layer behind the same
 * routing, security, or environment controls you want for the UI; generated
 * server URLs and operation metadata come from the API's OpenAPI annotations.
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as Layer from "../../Layer.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import * as HttpServerResponse from "../http/HttpServerResponse.ts"
import type * as HttpApi from "./HttpApi.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import * as Html from "./internal/html.ts"
import * as internal from "./internal/httpApiSwagger.ts"
import * as OpenApi from "./OpenApi.ts"

const makeHandler = <Id extends string, Groups extends HttpApiGroup.Any>(options: {
  readonly api: HttpApi.HttpApi<Id, Groups>
}) => {
  const spec = OpenApi.fromApi(options.api)
  const response = HttpServerResponse.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${Html.escape(spec.info.title)} Documentation</title>
  <style>${internal.css}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script id="swagger-spec" type="application/json">
    ${Html.escapeJson(spec)}
  </script>
  <script>
    ${internal.javascript}
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        spec: JSON.parse(document.getElementById("swagger-spec").textContent),
        dom_id: "#swagger-ui",
      });
    };
  </script>
</body>
</html>`)
  return Effect.succeed(response)
}

/**
 * Mounts Swagger UI for an `HttpApi` at the configured path, defaulting to
 * `/docs`, using the OpenAPI specification generated from the API.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly path?: `/${string}` | undefined
  }
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const handler = makeHandler({ api })
    yield* router.add("GET", options?.path ?? "/docs", handler)
  }))
