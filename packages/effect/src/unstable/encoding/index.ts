/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Utilities for encoding Effect channel payloads and schema values as
 * MessagePack bytes.
 *
 * This module is useful when a protocol or storage layer expects compact binary
 * frames instead of JSON text, such as RPC transports, socket streams, caches,
 * or database columns that carry typed Effect data. Use the raw channel helpers
 * when both sides already agree on the MessagePack value shape, and use the
 * schema-aware helpers when values should be validated, transformed, or decoded
 * into domain types at the boundary.
 *
 * MessagePack preserves binary data and common JavaScript collection shapes, but
 * it is still a data format rather than an Effect schema. Schema encoders run
 * before packing and schema decoders run after unpacking, so unsupported runtime
 * values, lossy schema encodings, or mismatched schemas surface as either
 * `MsgPackError` or `SchemaError` depending on where the failure occurs.
 *
 * @since 4.0.0
 */
export * as Msgpack from "./Msgpack.ts"

/**
 * Utilities for encoding Effect channel payloads and schema values as
 * newline-delimited JSON.
 *
 * NDJSON represents a stream as one complete JSON value per line, making this
 * module useful for log pipelines, long-lived HTTP responses, socket protocols,
 * and file formats where records should be processed incrementally instead of
 * buffering a whole JSON array. Use the byte helpers at transport boundaries
 * that speak UTF-8, the string helpers when text framing is already handled,
 * and the schema-aware helpers when each record should be validated or
 * transformed at the boundary.
 *
 * Encoders append a trailing newline after each emitted chunk, and decoders
 * tolerate records split across input chunks. Empty lines are only skipped when
 * `ignoreEmptyLines` is enabled; otherwise they are passed to `JSON.parse` and
 * fail like any other invalid JSON record.
 *
 * @since 4.0.0
 */
export * as Ndjson from "./Ndjson.ts"

/**
 * Utilities for parsing and rendering Server-Sent Events text streams.
 *
 * This module is useful at HTTP streaming boundaries that speak the EventSource
 * wire format, such as live updates, notifications, progress feeds, and other
 * unidirectional server-to-client event streams. It provides low-level parser
 * and encoder primitives, channel combinators for streaming chunks through
 * Effect pipelines, and schema-aware helpers for validating or transforming the
 * `id`, `event`, and string `data` fields at the edge of an application.
 *
 * SSE is line-oriented text rather than a framed binary protocol. Incoming
 * chunks may split fields across arbitrary boundaries, events are dispatched by
 * a blank line, repeated `data:` lines are joined with newlines, and `retry:`
 * directives are control messages rather than regular events. The decoder
 * handles UTF-8 byte order marks, CRLF and LF line endings, default `message`
 * events, and retry directives so callers can reconnect with the requested
 * delay while preserving the last event ID when available.
 *
 * @since 4.0.0
 */
export * as Sse from "./Sse.ts"
