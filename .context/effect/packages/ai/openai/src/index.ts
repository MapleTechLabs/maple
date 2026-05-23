/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * @since 4.0.0
 */
export * as Generated from "./Generated.ts"

/**
 * OpenAI Client module for interacting with OpenAI's API.
 *
 * Provides a type-safe, Effect-based client for OpenAI operations including
 * completions, embeddings, and streaming responses.
 *
 * @since 4.0.0
 */
export * as OpenAiClient from "./OpenAiClient.ts"

/**
 * @since 4.0.0
 */
export * as OpenAiClientGenerated from "./OpenAiClientGenerated.ts"

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
export * as OpenAiConfig from "./OpenAiConfig.ts"

/**
 * OpenAI Embedding Model implementation.
 *
 * Provides an EmbeddingModel implementation for OpenAI's embeddings API.
 *
 * @since 4.0.0
 */
export * as OpenAiEmbeddingModel from "./OpenAiEmbeddingModel.ts"

/**
 * OpenAI error metadata augmentation.
 *
 * Provides OpenAI-specific metadata fields for AI error types through module
 * augmentation, enabling typed access to OpenAI error details.
 *
 * @since 4.0.0
 */
export * as OpenAiError from "./OpenAiError.ts"

/**
 * OpenAI Language Model implementation.
 *
 * Provides a LanguageModel implementation for OpenAI's responses API,
 * supporting text generation, structured output, tool calling, and streaming.
 *
 * @since 4.0.0
 */
export * as OpenAiLanguageModel from "./OpenAiLanguageModel.ts"

/**
 * Minimal local OpenAI schemas used by the handwritten Responses client path.
 *
 * @since 4.0.0
 */
export * as OpenAiSchema from "./OpenAiSchema.ts"

/**
 * OpenAI telemetry attributes for OpenTelemetry integration.
 *
 * Provides OpenAI-specific GenAI telemetry attributes following OpenTelemetry
 * semantic conventions, extending the base GenAI attributes with OpenAI-specific
 * request and response metadata.
 *
 * @since 4.0.0
 */
export * as OpenAiTelemetry from "./OpenAiTelemetry.ts"

/**
 * OpenAI provider-defined tools for use with the LanguageModel.
 *
 * Provides tools that are natively supported by OpenAI's API, including
 * code interpreter, file search, and web search functionality.
 *
 * @since 4.0.0
 */
export * as OpenAiTool from "./OpenAiTool.ts"
