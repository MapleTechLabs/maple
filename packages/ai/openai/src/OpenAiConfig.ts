/**
 * The `OpenAiConfig` module provides contextual configuration for the
 * `@effect/ai-openai` integration. It is used to customize how OpenAI clients
 * are built and interpreted without threading configuration through every API
 * call manually.
 *
 * The primary use case is installing an HTTP client transform with
 * {@link withClientTransform}. This lets applications adapt the underlying
 * OpenAI HTTP client for cross-cutting concerns such as custom middleware,
 * instrumentation, proxying, or request policy changes while keeping the
 * OpenAI service APIs unchanged.
 *
 * Configuration is scoped through Effect's context, so transforms only apply to
 * the effect they are provided to and anything evaluated inside that scope.
 * When multiple transforms are needed, compose them into a single
 * `HttpClient => HttpClient` function before providing the configuration.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * Context service carrying scoped OpenAI configuration for provider
 * operations.
 *
 * @category services
 * @since 4.0.0
 */
export class OpenAiConfig extends Context.Service<
  OpenAiConfig,
  OpenAiConfig.Service
>()("@effect/ai-openai/OpenAiConfig") {
  /**
   * Gets the configured OpenAI service from the current context when present.
   *
   * @since 4.0.0
   */
  static readonly getOrUndefined: Effect.Effect<typeof OpenAiConfig.Service | undefined> = Effect.map(
    Effect.context<never>(),
    (context) => context.mapUnsafe.get(OpenAiConfig.key)
  )
}

/**
 * Types used by the `OpenAiConfig` context service.
 *
 * @since 4.0.0
 */
export declare namespace OpenAiConfig {
  /**
   * Configuration values read by OpenAI provider operations when executing
   * requests.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Service {
    readonly transformClient?: ((client: HttpClient) => HttpClient) | undefined
  }
}

/**
 * Provides a scoped transform for the OpenAI HTTP client used by provider
 * operations.
 *
 * @category configuration
 * @since 4.0.0
 */
export const withClientTransform: {
  (transform: (client: HttpClient) => HttpClient): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Effect.Effect<A, E, R>, transform: (client: HttpClient) => HttpClient): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  self: Effect.Effect<A, E, R>,
  transformClient: (client: HttpClient) => HttpClient
) =>
  Effect.flatMap(
    OpenAiConfig.getOrUndefined,
    (config) => Effect.provideService(self, OpenAiConfig, { ...config, transformClient })
  ))
