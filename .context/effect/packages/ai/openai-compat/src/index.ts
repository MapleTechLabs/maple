/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * The `OpenAiClient` module provides an Effect service for calling
 * OpenAI-compatible chat completions and embeddings APIs. It builds on the
 * Effect HTTP client, adds authentication and OpenAI header handling, and
 * exposes typed helpers for regular responses, server-sent event streaming, and
 * embedding requests.
 *
 * **Common tasks**
 *
 * - Create a client service directly with {@link make}
 * - Provide the service as a layer with {@link layer} or {@link layerConfig}
 * - Send non-streaming chat completion requests with `createResponse`
 * - Send streaming chat completion requests with `createResponseStream`
 * - Generate embeddings with `createEmbedding`
 * - Reuse the exported request and response types when integrating compatible providers
 *
 * **Gotchas**
 *
 * - The default base URL is `https://api.openai.com/v1`; set `apiUrl` for other
 *   OpenAI-compatible providers.
 * - `createResponseStream` forces `stream: true` and requests usage events with
 *   `stream_options.include_usage`.
 * - HTTP and schema decoding failures are mapped into `AiError`.
 *
 * @since 4.0.0
 */
export * as OpenAiClient from "./OpenAiClient.ts"

/**
 * The `OpenAiConfig` module provides shared configuration for clients that
 * talk to OpenAI-compatible APIs. It is used to customize the HTTP client
 * wiring around a provider without changing the higher-level model,
 * embeddings, or tool-calling APIs that consume the client.
 *
 * **Common tasks**
 *
 * - Install a client transform with {@link withClientTransform}
 * - Add provider-specific HTTP behavior, such as headers, retries, proxies, or
 *   instrumentation
 * - Read the active configuration from the Effect context when implementing
 *   OpenAI-compatible integrations
 *
 * **Gotchas**
 *
 * - The transform receives and returns an `HttpClient`, so it should preserve
 *   the existing client behavior unless it intentionally replaces it
 * - Configuration is provided through Effect context and is scoped to the
 *   effect that receives the service
 *
 * @since 4.0.0
 */
export * as OpenAiConfig from "./OpenAiConfig.ts"

/**
 * OpenAI Embedding Model implementation.
 *
 * Provides an EmbeddingModel implementation for OpenAI-compatible embeddings APIs.
 *
 * @since 4.0.0
 */
export * as OpenAiEmbeddingModel from "./OpenAiEmbeddingModel.ts"

/**
 * The `OpenAiError` module defines OpenAI-specific metadata that can be
 * attached to the shared `AiError` error types used by the AI packages. It is
 * primarily used by OpenAI-compatible clients to preserve provider details
 * such as error codes, error types, request IDs, and rate limit headers while
 * still exposing errors through the provider-neutral Effect AI error model.
 *
 * Use this module when mapping OpenAI API failures into `AiError` values and
 * when consumers need enough structured metadata to debug failed requests,
 * inspect quota or rate limit responses, or correlate an error with OpenAI
 * support. The exported types are metadata shapes only; the module augmentation
 * makes those shapes available on the corresponding shared AI error metadata
 * interfaces without defining new runtime error classes.
 *
 * @since 4.0.0
 */
export * as OpenAiError from "./OpenAiError.ts"

/**
 * OpenAI Language Model implementation.
 *
 * Provides a LanguageModel implementation for OpenAI's chat completions API,
 * supporting text generation, structured output, tool calling, and streaming.
 *
 * @since 4.0.0
 */
export * as OpenAiLanguageModel from "./OpenAiLanguageModel.ts"

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
