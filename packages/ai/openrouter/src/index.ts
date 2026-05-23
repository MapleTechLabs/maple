/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * @since 4.0.0
 */
export * as Generated from "./Generated.ts"

/**
 * The `OpenRouterClient` module provides an Effect service for calling
 * OpenRouter's chat completions API. It wraps the generated OpenRouter HTTP
 * client with Effect-native constructors, layers, typed errors, and streaming
 * support.
 *
 * **Common tasks**
 *
 * - Build a client from explicit options with {@link make}
 * - Provide the client to an application with {@link layer} or {@link layerConfig}
 * - Create non-streaming chat completions with {@link Service.createChatCompletion}
 * - Create server-sent event chat completion streams with
 *   {@link Service.createChatCompletionStream}
 * - Customize authentication, base URL, OpenRouter ranking headers, or the
 *   underlying HTTP client through {@link Options}
 *
 * **Gotchas**
 *
 * - Streaming requests are sent directly to `/chat/completions` with `stream`
 *   and `stream_options.include_usage` enabled by this module.
 * - OpenRouter API failures, HTTP client failures, and schema decoding failures
 *   are mapped into `AiError` values for the exported service methods.
 *
 * @since 4.0.0
 */
export * as OpenRouterClient from "./OpenRouterClient.ts"

/**
 * The `OpenRouterConfig` module provides contextual configuration for the
 * OpenRouter provider integration. It is used to customize the HTTP client that
 * backs OpenRouter requests without rebuilding the provider layer itself.
 *
 * Use {@link withClientTransform} when a single effect, workflow, or scoped
 * portion of an application needs to add cross-cutting HTTP client behavior
 * such as request logging, retries, proxy routing, additional headers, or test
 * doubles. The configuration is read from the current Effect context, so the
 * transform only applies where the returned effect is run with that context.
 *
 * **Gotchas**
 *
 * - Each call to {@link withClientTransform} replaces the current client
 *   transform for the provided effect; compose transforms manually when both
 *   behaviors should apply.
 * - The transform receives and returns an `HttpClient`, so it should preserve
 *   the OpenRouter client contract while adding behavior around it.
 *
 * @since 4.0.0
 */
export * as OpenRouterConfig from "./OpenRouterConfig.ts"

/**
 * OpenRouter error metadata augmentation.
 *
 * Provides OpenRouter-specific metadata fields for AI error types through
 * module augmentation, enabling typed access to OpenRouter error details.
 *
 * @since 4.0.0
 */
export * as OpenRouterError from "./OpenRouterError.ts"

/**
 * The `OpenRouterLanguageModel` module provides constructors for using
 * OpenRouter chat completion models through the Effect AI `LanguageModel`
 * interface. It adapts Effect prompts, tools, structured output schemas, file
 * parts, reasoning details, cache-control hints, and telemetry annotations into
 * the OpenRouter request and response formats.
 *
 * Use this module when an application wants to select an OpenRouter model by
 * name while keeping the rest of its AI workflow provider-agnostic. The
 * exported layer and model constructors install a `LanguageModel` service backed
 * by `OpenRouterClient`, and `withConfigOverride` can scope per-request
 * OpenRouter options such as sampling, routing, tool use, or JSON schema
 * behavior.
 *
 * OpenRouter routes requests to many underlying providers, so model support for
 * images, files, tools, structured outputs, caching, and reasoning metadata can
 * vary. Provider-specific prompt and response metadata is preserved under the
 * `openrouter` option namespace so multi-turn conversations can round-trip
 * details such as reasoning blocks and file annotations when the selected model
 * supports them.
 *
 * @since 4.0.0
 */
export * as OpenRouterLanguageModel from "./OpenRouterLanguageModel.ts"
