/**
 * Browser geolocation support for Effect programs.
 *
 * This module provides a `Geolocation` service and browser-backed layer for
 * reading device location through `navigator.geolocation`. Use
 * `getCurrentPosition` when an application needs one location fix, such as a
 * nearby-search, check-in, or delivery estimate, and `watchPosition` when it
 * needs a stream of updates for navigation, tracking, or location-aware UI.
 *
 * The implementation is browser-only and relies on the browser permission and
 * policy model for geolocation. Calls may prompt the user, fail when permission
 * is denied, time out, or report that position data is unavailable because of
 * device, browser, privacy, origin, or secure-context restrictions. Watched
 * positions are scoped so the underlying browser watch is cleared when the
 * stream is finalized, and slow consumers should account for the sliding
 * buffer used by `watchPosition`.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"

const TypeId = "~@effect/platform-browser/Geolocation"
const ErrorTypeId = "~@effect/platform-browser/Geolocation/GeolocationError"

/**
 * Service interface for browser geolocation, providing effects for the current position and streams of watched positions.
 *
 * @category models
 * @since 4.0.0
 */
export interface Geolocation {
  readonly [TypeId]: typeof TypeId
  readonly getCurrentPosition: (
    options?: PositionOptions | undefined
  ) => Effect.Effect<GeolocationPosition, GeolocationError>
  readonly watchPosition: (
    options?:
      | PositionOptions & {
        readonly bufferSize?: number | undefined
      }
      | undefined
  ) => Stream.Stream<GeolocationPosition, GeolocationError>
}

/**
 * Service tag for the browser `Geolocation` service.
 *
 * @category services
 * @since 4.0.0
 */
export const Geolocation: Context.Service<Geolocation, Geolocation> = Context.Service<Geolocation>(TypeId)

/**
 * Tagged error wrapping a browser geolocation failure reason.
 *
 * @category errors
 * @since 4.0.0
 */
export class GeolocationError extends Data.TaggedError("GeolocationError")<{
  readonly reason: GeolocationErrorReason
}> {
  constructor(props: {
    readonly reason: GeolocationErrorReason
  }) {
    super({
      ...props,
      cause: props.reason.cause
    } as any)
  }

  readonly [ErrorTypeId] = ErrorTypeId

  override get message(): string {
    return this.reason.message
  }
}

/**
 * Error reason for the browser geolocation `POSITION_UNAVAILABLE` failure.
 *
 * @category errors
 * @since 4.0.0
 */
export class PositionUnavailable extends Data.TaggedError("PositionUnavailable")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * Error reason for the browser geolocation `PERMISSION_DENIED` failure.
 *
 * @category errors
 * @since 4.0.0
 */
export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * Error reason for the browser geolocation `TIMEOUT` failure.
 *
 * @category errors
 * @since 4.0.0
 */
export class Timeout extends Data.TaggedError("Timeout")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * Union of browser geolocation error reasons represented by the service.
 *
 * @category errors
 * @since 4.0.0
 */
export type GeolocationErrorReason = PositionUnavailable | PermissionDenied | Timeout

const makeQueue = (
  options:
    | PositionOptions & {
      readonly bufferSize?: number | undefined
    }
    | undefined
) =>
  Queue.sliding<GeolocationPosition, GeolocationError>(options?.bufferSize ?? 16).pipe(
    Effect.tap((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          navigator.geolocation.watchPosition(
            (position) => Queue.offerUnsafe(queue, position),
            (cause) => {
              if (cause.code === cause.PERMISSION_DENIED) {
                const error = new GeolocationError({
                  reason: new PermissionDenied({ cause })
                })
                Queue.failCauseUnsafe(queue, Cause.fail(error))
              } else if (cause.code === cause.TIMEOUT) {
                const error = new GeolocationError({
                  reason: new Timeout({ cause })
                })
                Queue.failCauseUnsafe(queue, Cause.fail(error))
              } else if (cause.code === cause.POSITION_UNAVAILABLE) {
                const error = new GeolocationError({
                  reason: new PositionUnavailable({ cause })
                })
                Queue.failCauseUnsafe(queue, Cause.fail(error))
              }
            },
            options
          )
        ),
        (handleId) => Effect.sync(() => navigator.geolocation.clearWatch(handleId))
      )
    )
  )

/**
 * Layer that provides `Geolocation` using `navigator.geolocation`, with watched positions buffered in a sliding queue.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Geolocation> = Layer.succeed(
  Geolocation,
  Geolocation.of({
    [TypeId]: TypeId,
    getCurrentPosition: (options) =>
      makeQueue(options).pipe(
        Effect.flatMap(Queue.take),
        Effect.scoped
      ),
    watchPosition: (options) =>
      makeQueue(options).pipe(
        Effect.map(Stream.fromQueue),
        Stream.unwrap
      )
  })
)

/**
 * Streams positions from the `Geolocation` service using `watchPosition`, with an optional sliding buffer size.
 *
 * @category Accessors
 * @since 4.0.0
 */
export const watchPosition = (
  options?:
    | PositionOptions & {
      readonly bufferSize?: number | undefined
    }
    | undefined
): Stream.Stream<GeolocationPosition, GeolocationError, Geolocation> =>
  Stream.unwrap(Effect.map(
    Effect.service(Geolocation),
    (geolocation) => geolocation.watchPosition(options)
  ))
