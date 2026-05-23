/**
 * The `HttpApiScalar` module mounts an interactive Scalar API reference for a
 * declarative `HttpApi`.
 *
 * Use this module when you want a browser-friendly documentation page for an
 * `HttpApi` without maintaining a separate OpenAPI document. The `layer`
 * helper registers a `GET` route on an `HttpRouter`, generates the OpenAPI
 * specification with `OpenApi.fromApi`, embeds it into the HTML page, and loads
 * the bundled Scalar browser script. `layerCdn` provides the same UI while
 * loading Scalar from jsDelivr, optionally pinned with `version`.
 *
 * The mounted path is a documentation UI route, defaulting to `/docs`, rather
 * than a raw JSON specification endpoint. If clients, gateways, or external
 * documentation pipelines need the OpenAPI document directly, expose it
 * separately with `HttpApiBuilder.layer`'s `openapiPath` option. Scalar
 * configuration is forwarded to the page through `ScalarConfig`; values such as
 * `proxyUrl`, theme and layout settings, and `baseServerURL` matter when
 * enabling "Test Request", styling the docs, or rendering relative server URLs
 * outside the browser origin.
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
import * as internal from "./internal/httpApiScalar.ts"
import * as OpenApi from "./OpenApi.ts"

/**
 * Theme preset identifier accepted by the Scalar API reference UI.
 *
 * @category models
 * @since 4.0.0
 */
export type ScalarThemeId =
  | "alternate"
  | "default"
  | "moon"
  | "purple"
  | "solarized"
  | "bluePlanet"
  | "saturn"
  | "kepler"
  | "mars"
  | "deepSpace"
  | "laserwave"
  | "none"

/**
 * Configuration passed to the embedded Scalar API reference UI.
 *
 * @see https://github.com/scalar/scalar/blob/main/documentation/configuration.md
 *
 * @category models
 * @since 4.0.0
 */
export type ScalarConfig = {
  /** A string to use one of the color presets */
  theme?: ScalarThemeId
  /** The layout to use for the references */
  layout?: "modern" | "classic"
  /** URL to a request proxy for the API client */
  proxyUrl?: string
  /** Whether to show the sidebar */
  showSidebar?: boolean
  /**
   * Whether to show models in the sidebar, search, and content.
   *
   * @default false
   */
  hideModels?: boolean
  /**
   * Whether to show the "Test Request" button.
   *
   * @default false
   */
  hideTestRequestButton?: boolean
  /**
   * Whether to show the sidebar search bar.
   *
   * @default false
   */
  hideSearch?: boolean
  /** Whether dark mode is on or off initially (light mode) */
  darkMode?: boolean
  /** forceDarkModeState makes it always this state no matter what */
  forceDarkModeState?: "dark" | "light"
  /** Whether to show the dark mode toggle */
  hideDarkModeToggle?: boolean
  /**
   * Path to a favicon image.
   *
   * **Example** (Relative favicon)
   *
   * ```ts
   * const favicon = "/favicon.svg"
   * ```
   *
   * @default undefined
   */
  favicon?: string
  /** Custom CSS to be added to the page */
  customCss?: string
  /**
   * Origin used when the OpenAPI document contains relative server URLs and is
   * rendered during SSR.
   *
   * **Details**
   *
   * Browsers can derive the origin from `window.location.origin`; server
   * rendering needs this value supplied explicitly.
   *
   * **Example** (Local server URL)
   *
   * ```ts
   * const baseServerURL = "http://localhost:3000"
   * ```
   *
   * @default undefined
   */
  baseServerURL?: string
  /**
   * Whether Scalar loads its default Inter and JetBrains Mono fonts.
   *
   * **Details**
   *
   * Set this to `false` when supplying custom fonts.
   *
   * @default true
   */
  withDefaultFonts?: boolean
  /**
   * Whether all tags are open by default instead of only the tag matching the
   * current URL.
   *
   * @default false
   */
  defaultOpenAllTags?: boolean
  /**
   * Whether to display the operation ID in the operation reference.
   *
   * @default false
   */
  showOperationId?: boolean
}

type ScalarSource =
  | {
    readonly _tag: "Cdn"
    readonly version?: string | undefined
  }
  | {
    readonly _tag: "Inline"
    readonly source: string
  }

const makeHandler = <Id extends string, Groups extends HttpApiGroup.Any>(options: {
  readonly api: HttpApi.HttpApi<Id, Groups>
  readonly source: ScalarSource
  readonly scalar: ScalarConfig | undefined
}) => {
  const spec = OpenApi.fromApi(options.api)
  const scalarConfig = {
    _integration: "html",
    ...options.scalar
  }
  const response = HttpServerResponse.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${Html.escape(spec.info.title)}</title>
    ${
    !spec.info.description
      ? ""
      : `<meta name="description" content="${Html.escape(spec.info.description)}"/>`
  }
    ${
    !spec.info.description
      ? ""
      : `<meta name="og:description" content="${Html.escape(spec.info.description)}"/>`
  }
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" type="application/json">
      ${Html.escapeJson(spec)}
    </script>
    <script>
      document.getElementById('api-reference').dataset.configuration = JSON.stringify(${Html.escapeJson(scalarConfig)})
    </script>
    ${
    options.source._tag === "Cdn"
      ? `<script src="${`https://cdn.jsdelivr.net/npm/@scalar/api-reference@${
        options.source.version ?? "latest"
      }/dist/browser/standalone.min.js`}" crossorigin></script>`
      : `<script>${options.source.source}</script>`
  }
  </body>
</html>`)
  return Effect.succeed(response)
}

/**
 * Mounts a Scalar API reference page for an `HttpApi` using the bundled Scalar script.
 *
 * **Details**
 *
 * The route serves the OpenAPI specification generated from the API at the
 * configured path, defaulting to `/docs`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly path?: `/${string}` | undefined
    readonly scalar?: ScalarConfig
  } | undefined
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const handler = makeHandler({
      api,
      source: {
        _tag: "Inline",
        source: internal.javascript
      },
      scalar: options?.scalar
    })
    yield* router.add("GET", options?.path ?? "/docs", handler)
  }))

/**
 * Mounts a Scalar API reference page for an `HttpApi` that loads Scalar from jsDelivr.
 *
 * **Details**
 *
 * The route serves the OpenAPI specification generated from the API at the
 * configured path, defaulting to `/docs`; `version` selects the Scalar package
 * version loaded from the CDN.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerCdn = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly path?: `/${string}` | undefined
    readonly scalar?: ScalarConfig
    readonly version?: string | undefined
  } | undefined
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const handler = makeHandler({
      api,
      source: {
        _tag: "Cdn",
        version: options?.version
      },
      scalar: options?.scalar
    })
    yield* router.add("GET", options?.path ?? "/docs", handler)
  }))
