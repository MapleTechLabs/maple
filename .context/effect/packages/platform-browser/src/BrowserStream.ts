/**
 * Browser `Stream` constructors for DOM event targets.
 *
 * This module provides typed helpers for turning `window.addEventListener` and
 * `document.addEventListener` callbacks into Effect `Stream`s. They are useful
 * for UI and runtime signals such as resize, visibility, keyboard, pointer,
 * focus, online / offline, and other browser events that should be composed
 * with Effect stream operators and finalized with the consuming fiber.
 *
 * Browser events are push-based `EventTarget` notifications, so they do not
 * apply Web Streams backpressure to the browser event source. Events are
 * buffered until downstream pulls them; the default buffer is unbounded, so
 * high-frequency sources like scroll, pointermove, or mousemove should usually
 * set `bufferSize` and use stream operators that sample, debounce, throttle, or
 * drop work as appropriate.
 *
 * These helpers are for DOM events, not for adapting `ReadableStream` request
 * or response bodies. Fetch bodies follow the Web Streams body rules, including
 * single-consumer locking and disturbed bodies after reads, and should be
 * handled with body-specific HTTP or Web Streams APIs instead. When using the
 * browser `once` option, pair the stream with `Stream.take(1)` if a finite
 * stream is required.
 *
 * @since 4.0.0
 */

import * as Stream from "effect/Stream"

/**
 * Creates a `Stream` from `window.addEventListener`.
 *
 * **Details**
 *
 * By default, the underlying buffer is unbounded in size. You can customize the
 * buffer size by passing an object as the second argument with the `bufferSize`
 * field.
 *
 * @category Streams
 * @since 4.0.0
 */
export const fromEventListenerWindow = <K extends keyof WindowEventMap>(
  type: K,
  options?: boolean | {
    readonly capture?: boolean
    readonly passive?: boolean
    readonly once?: boolean
    readonly bufferSize?: number | undefined
  } | undefined
): Stream.Stream<WindowEventMap[K], never, never> => Stream.fromEventListener<WindowEventMap[K]>(window, type, options)

/**
 * Creates a `Stream` from `document.addEventListener`.
 *
 * **Details**
 *
 * By default, the underlying buffer is unbounded in size. You can customize the
 * buffer size by passing an object as the second argument with the `bufferSize`
 * field.
 *
 * @category Streams
 * @since 4.0.0
 */
export const fromEventListenerDocument = <K extends keyof DocumentEventMap>(
  type: K,
  options?: boolean | {
    readonly capture?: boolean
    readonly passive?: boolean
    readonly once?: boolean
    readonly bufferSize?: number | undefined
  } | undefined
): Stream.Stream<DocumentEventMap[K], never, never> =>
  Stream.fromEventListener<DocumentEventMap[K]>(document, type, options)
