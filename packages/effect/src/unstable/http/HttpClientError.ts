/**
 * Error types used by the HTTP client to describe failures that occur while
 * preparing requests, sending them, validating response status codes, and
 * decoding response bodies.
 *
 * The module exposes the `HttpClientError` wrapper together with the specific
 * reason classes it can carry, so applications can either handle all HTTP
 * client failures uniformly or branch on the exact `_tag` for retries, logging,
 * metrics, and user-facing messages. A common gotcha is that only response
 * errors carry an `HttpClientResponse`: transport, encoding, and invalid URL
 * failures happen before a response is available, while status-code, decode, and
 * empty-body failures preserve the response that triggered them.
 *
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type * as HttpClientRequest from "./HttpClientRequest.ts"
import type * as ClientResponse from "./HttpClientResponse.ts"

const TypeId = "~effect/http/HttpClientError"

/**
 * Returns `true` when a value is an `HttpClientError`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isHttpClientError = (u: unknown): u is HttpClientError => hasProperty(u, TypeId)

/**
 * Error wrapper for HTTP client failures, exposing the failed request and the optional response through its `reason`.
 *
 * @category error
 * @since 4.0.0
 */
export class HttpClientError extends Data.TaggedError("HttpClientError")<{
  readonly reason: HttpClientErrorReason
}> {
  constructor(props: {
    readonly reason: HttpClientErrorReason
  }) {
    if ("cause" in props.reason) {
      super({
        ...props,
        cause: props.reason.cause
      } as any)
    } else {
      super(props)
    }
  }

  /**
   * Marks this value as an HTTP client error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * HTTP request associated with the client failure.
   *
   * @since 4.0.0
   */
  get request(): HttpClientRequest.HttpClientRequest {
    return this.reason.request
  }

  /**
   * HTTP response associated with the client failure, when one was received.
   *
   * @since 4.0.0
   */
  get response(): ClientResponse.HttpClientResponse | undefined {
    return "response" in this.reason ? this.reason.response : undefined
  }

  override get message(): string {
    return this.reason.message
  }
}

const formatReason = (tag: string) => tag.endsWith("Error") ? tag.slice(0, -5) : tag

const formatMessage = (reason: string, description: string | undefined, info: string) =>
  description ? `${reason}: ${description} (${info})` : `${reason} error (${info})`

/**
 * Request error for transport-level failures that occur while sending an HTTP request.
 *
 * @category error
 * @since 4.0.0
 */
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly cause?: unknown
  readonly description?: string
}> {
  /**
   * Formats the request method and URL for transport error messages.
   *
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * Builds the transport error message from the optional description and request details.
   *
   * @since 4.0.0
   */
  override get message() {
    return formatMessage(formatReason(this._tag), this.description, this.methodAndUrl)
  }
}

/**
 * Request error for failures while encoding an HTTP request body.
 *
 * @category error
 * @since 4.0.0
 */
export class EncodeError extends Data.TaggedError("EncodeError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly cause?: unknown
  readonly description?: string
}> {
  /**
   * Formats the request method and URL for request encoding error messages.
   *
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * Builds the request encoding error message from the optional description and request details.
   *
   * @since 4.0.0
   */
  override get message() {
    return formatMessage(formatReason(this._tag), this.description, this.methodAndUrl)
  }
}

/**
 * Request error for failures while constructing a URL from an HTTP client request.
 *
 * @category error
 * @since 4.0.0
 */
export class InvalidUrlError extends Data.TaggedError("InvalidUrlError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly cause?: unknown
  readonly description?: string
}> {
  /**
   * Formats the request method and URL for invalid URL error messages.
   *
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * Builds the invalid URL error message from the optional description and request details.
   *
   * @since 4.0.0
   */
  override get message() {
    return formatMessage(formatReason(this._tag), this.description, this.methodAndUrl)
  }
}

/**
 * Response error for HTTP responses rejected because of their status code.
 *
 * @category error
 * @since 4.0.0
 */
export class StatusCodeError extends Data.TaggedError("StatusCodeError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: ClientResponse.HttpClientResponse
  readonly cause?: unknown
  readonly description?: string | undefined
}> {
  /**
   * Formats the request method and URL for status code error messages.
   *
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * Builds the status code error message from the response status, optional description, and request details.
   *
   * @since 4.0.0
   */
  override get message() {
    const info = `${this.response.status} ${this.methodAndUrl}`
    return formatMessage(formatReason(this._tag), this.description, info)
  }
}

/**
 * Response error for failures while decoding an HTTP response body.
 *
 * @category error
 * @since 4.0.0
 */
export class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: ClientResponse.HttpClientResponse
  readonly cause?: unknown
  readonly description?: string | undefined
}> {
  /**
   * Formats the request method and URL for response decoding error messages.
   *
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * Builds the response decoding error message from the response status, optional description, and request details.
   *
   * @since 4.0.0
   */
  override get message() {
    const info = `${this.response.status} ${this.methodAndUrl}`
    return formatMessage(formatReason(this._tag), this.description, info)
  }
}

/**
 * Response error for operations that expected a response body but received an empty body.
 *
 * @category error
 * @since 4.0.0
 */
export class EmptyBodyError extends Data.TaggedError("EmptyBodyError")<{
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: ClientResponse.HttpClientResponse
  readonly cause?: unknown
  readonly description?: string | undefined
}> {
  /**
   * Formats the request method and URL for empty response body error messages.
   *
   * @since 4.0.0
   */
  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  /**
   * Builds the empty body error message from the response status, optional description, and request details.
   *
   * @since 4.0.0
   */
  override get message() {
    const info = `${this.response.status} ${this.methodAndUrl}`
    return formatMessage(formatReason(this._tag), this.description, info)
  }
}

/**
 * Union of HTTP client errors that occur before a response is available.
 *
 * @category error
 * @since 4.0.0
 */
export type RequestError = TransportError | EncodeError | InvalidUrlError

/**
 * Union of HTTP client errors that include an HTTP response.
 *
 * @category error
 * @since 4.0.0
 */
export type ResponseError = StatusCodeError | DecodeError | EmptyBodyError

/**
 * Union of all specific failure reasons carried by `HttpClientError`.
 *
 * @category error
 * @since 4.0.0
 */
export type HttpClientErrorReason = RequestError | ResponseError

/**
 * Serializable schema representation of an `HttpClientError`, preserving the specific error kind and cause.
 *
 * @category schemas
 * @since 4.0.0
 */
export class HttpClientErrorSchema extends Schema.ErrorClass<HttpClientErrorSchema>(TypeId)({
  _tag: Schema.tag("HttpError"),
  kind: Schema.Literals(
    [
      "EncodeError",
      "DecodeError",
      "TransportError",
      "InvalidUrlError",
      "StatusCodeError",
      "EmptyBodyError"
    ] satisfies ReadonlyArray<HttpClientErrorReason["_tag"]>
  ),
  cause: Schema.optional(Schema.Defect)
}) {
  /**
   * Builds the serializable schema representation for an HTTP client error.
   *
   * @since 4.0.0
   */
  static fromHttpClientError(error: HttpClientError): HttpClientErrorSchema {
    return new HttpClientErrorSchema({
      _tag: "HttpError",
      kind: error.reason._tag,
      cause: error.reason
    })
  }
}
