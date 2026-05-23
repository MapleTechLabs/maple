/**
 * The `HttpApiSecurity` module defines the security scheme values used by
 * declarative HTTP APIs.
 *
 * Use these constructors when an API group or endpoint needs authentication
 * middleware for bearer tokens, API keys, or HTTP Basic credentials. The values
 * are intentionally small declarations: `HttpApiMiddleware.Service` attaches
 * them to middleware, `HttpApiBuilder` decodes the matching credential shape from
 * each request, and OpenAPI generation emits the corresponding
 * `components.securitySchemes` and operation security requirements.
 *
 * Common uses include modeling `Authorization: Bearer ...` tokens, Basic
 * username/password credentials, and API keys passed through headers, query
 * parameters, or cookies. Bearer tokens and API-key values are exposed to
 * middleware as `Redacted` values; Basic credentials expose the username with a
 * redacted password. Cookie API keys can also be written to responses with
 * `HttpApiBuilder.securitySetCookie`.
 *
 * A security scheme does not authenticate by itself: middleware must reject empty
 * or invalid credentials. Bearer and Basic schemes read the `Authorization`
 * header, while API-key headers use HTTP header name normalization and API-key
 * query or cookie names are matched exactly. OpenAPI annotations such as
 * descriptions and bearer formats affect generated documentation only; they do
 * not change runtime decoding.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import { dual } from "../../Function.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import type { Redacted } from "../../Redacted.ts"
import type { Covariant } from "../../Types.ts"

const TypeId = "~effect/httpapi/HttpApiSecurity"

/**
 * Union of security schemes supported by the HTTP API OpenAPI model.
 *
 * @category models
 * @since 4.0.0
 */
export type HttpApiSecurity = Bearer | ApiKey | Basic

/**
 * Helper types for HTTP API security schemes.
 *
 * @since 4.0.0
 */
export declare namespace HttpApiSecurity {
  /**
   * Common prototype for security schemes, carrying the credential type and OpenAPI annotations.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Proto<out A> extends Pipeable {
    readonly [TypeId]: {
      readonly _A: Covariant<A>
    }
    readonly annotations: Context.Context<never>
  }

  /**
   * Extracts the credential type produced by a security scheme.
   *
   * @category models
   * @since 4.0.0
   */
  export type Type<A extends HttpApiSecurity> = A extends Proto<infer Out> ? Out : never
}

/**
 * Bearer token security scheme whose decoded credential is a redacted token.
 *
 * @category models
 * @since 4.0.0
 */
export interface Bearer extends HttpApiSecurity.Proto<Redacted> {
  readonly _tag: "Bearer"
}

/**
 * API key security scheme identifying the key name and whether it is read from a header, query parameter, or cookie.
 *
 * @category models
 * @since 4.0.0
 */
export interface ApiKey extends HttpApiSecurity.Proto<Redacted> {
  readonly _tag: "ApiKey"
  readonly in: "header" | "query" | "cookie"
  readonly key: string
}

/**
 * HTTP Basic authentication security scheme whose decoded credential is `Credentials`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Basic extends HttpApiSecurity.Proto<Credentials> {
  readonly _tag: "Basic"
}

/**
 * Decoded credentials for HTTP Basic authentication.
 *
 * @category models
 * @since 4.0.0
 */
export interface Credentials {
  readonly username: string
  readonly password: Redacted
}

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Creates a Bearer token security scheme.
 *
 * **When to use**
 *
 * Use `HttpApiBuilder.middlewareSecurity` to implement API middleware for this
 * security scheme.
 *
 * @category constructors
 * @since 4.0.0
 */
export const bearer: Bearer = Object.assign(Object.create(Proto), {
  _tag: "Bearer",
  annotations: Context.empty()
})

/**
 * Creates an API key security scheme.
 *
 * **When to use**
 *
 * Use `HttpApiBuilder.middlewareSecurity` to implement API middleware for this
 * security scheme.
 *
 * **Details**
 *
 * Use `HttpApiBuilder.securitySetCookie` to set the correct cookie in a
 * handler. By default, `in` is `"header"`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const apiKey = (options: {
  readonly key: string
  readonly in?: "header" | "query" | "cookie" | undefined
}): ApiKey =>
  Object.assign(Object.create(Proto), {
    _tag: "ApiKey",
    key: options.key,
    in: options.in ?? "header",
    annotations: Context.empty()
  })

/**
 * Creates an HTTP Basic authentication security scheme.
 *
 * **When to use**
 *
 * Use `HttpApiBuilder.middlewareSecurity` to implement API middleware for this
 * security scheme.
 *
 * @category constructors
 * @since 4.0.0
 */
export const basic: Basic = Object.assign(Object.create(Proto), {
  _tag: "Basic",
  annotations: Context.empty()
})

/**
 * Merges OpenAPI annotations into a security scheme.
 *
 * @category annotations
 * @since 4.0.0
 */
export const annotateMerge: {
  <I>(annotations: Context.Context<I>): <A extends HttpApiSecurity>(self: A) => A
  <A extends HttpApiSecurity, I>(self: A, annotations: Context.Context<I>): A
} = dual(
  2,
  <A extends HttpApiSecurity, I>(self: A, annotations: Context.Context<I>): A =>
    Object.assign(Object.create(Proto), {
      ...self,
      annotations: Context.merge(self.annotations, annotations)
    })
)

/**
 * Adds an OpenAPI annotation value to a security scheme.
 *
 * @category annotations
 * @since 4.0.0
 */
export const annotate: {
  <I, S>(service: Context.Key<I, S>, value: S): <A extends HttpApiSecurity>(self: A) => A
  <A extends HttpApiSecurity, I, S>(self: A, service: Context.Key<I, S>, value: S): A
} = dual(
  3,
  <A extends HttpApiSecurity, I, S>(self: A, service: Context.Key<I, S>, value: S): A =>
    Object.assign(Object.create(Proto), {
      ...self,
      annotations: Context.add(self.annotations, service, value)
    })
)
