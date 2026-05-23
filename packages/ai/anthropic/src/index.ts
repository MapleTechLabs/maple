/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Anthropic Client module for interacting with Anthropic's API.
 *
 * Provides a type-safe, Effect-based client for Anthropic operations including
 * messages and streaming responses.
 *
 * @since 4.0.0
 */
export * as AnthropicClient from "./AnthropicClient.ts"

/**
 * The `AnthropicConfig` module provides contextual configuration for the
 * Anthropic AI provider integration. It is used to customize the generated
 * Anthropic HTTP client without changing individual request code.
 *
 * **Common tasks**
 *
 * - Provide a shared `HttpClient` transformation for Anthropic requests
 * - Add provider-specific concerns such as request instrumentation, proxying,
 *   retries, or header manipulation
 * - Scope a client transformation to a single effect with {@link withClientTransform}
 *
 * **Gotchas**
 *
 * - Configuration is read from the Effect context, so overrides only apply to
 *   effects run inside the configured scope
 * - `withClientTransform` replaces the current `transformClient` value while
 *   preserving any other Anthropic configuration fields
 *
 * @since 4.0.0
 */
export * as AnthropicConfig from "./AnthropicConfig.ts"

/**
 * Anthropic error metadata augmentation.
 *
 * Provides Anthropic-specific metadata fields for AI error types through module
 * augmentation, enabling typed access to Anthropic error details.
 *
 * @since 4.0.0
 */
export * as AnthropicError from "./AnthropicError.ts"

/**
 * The `AnthropicLanguageModel` module provides the Anthropic implementation of
 * Effect AI's `LanguageModel` service. It turns Effect AI prompts, tools, files,
 * reasoning parts, and provider options into Anthropic Messages API requests,
 * and converts Anthropic responses and streams back into Effect AI response
 * parts with Anthropic-specific metadata.
 *
 * **When to use**
 *
 * - Create an Anthropic-backed model with {@link model}
 * - Build or provide a `LanguageModel.LanguageModel` layer with {@link layer}
 *   or {@link make}
 * - Supply default request options through {@link Config}
 * - Override configuration for a scoped operation with {@link withConfigOverride}
 * - Attach Anthropic provider options for prompt caching, document citations,
 *   reasoning signatures, MCP metadata, and server-side tools
 *
 * **Gotchas**
 *
 * - Prompt files are translated to Anthropic image or document blocks; only the
 *   supported media types can be sent to the provider.
 * - Structured output support depends on the selected Claude model, so this
 *   module may use Anthropic's native structured output or fall back to a JSON
 *   response tool.
 * - Some features require Anthropic beta headers, which are added
 *   automatically from the selected tools, files, and model capabilities.
 *
 * @since 4.0.0
 */
export * as AnthropicLanguageModel from "./AnthropicLanguageModel.ts"

/**
 * Anthropic telemetry attributes for OpenTelemetry integration.
 *
 * Provides Anthropic-specific GenAI telemetry attributes following OpenTelemetry
 * semantic conventions, extending the base GenAI attributes with Anthropic-specific
 * request and response metadata.
 *
 * @since 4.0.0
 */
export * as AnthropicTelemetry from "./AnthropicTelemetry.ts"

/**
 * Anthropic provider-defined tools for use with the LanguageModel.
 *
 * Provides tools that are natively supported by Anthropic's API, including
 * Bash, Code Execution, Computer Use, Memory, and Text Editor functionality.
 *
 * @since 4.0.0
 */
export * as AnthropicTool from "./AnthropicTool.ts"

/**
 * @since 4.0.0
 */
export * as Generated from "./Generated.ts"
