/**
 * Browser Permissions API support for Effect programs.
 *
 * This module provides a `Permissions` service and browser-backed layer for
 * querying `navigator.permissions` from Effect code. Use it to check whether a
 * browser capability is currently `granted`, `prompt`, or `denied` before
 * showing UI for flows such as geolocation, notifications, clipboard access,
 * camera, microphone, or persistent storage.
 *
 * Permission queries do not request access by themselves and should not replace
 * the feature API that actually performs the operation. Browser support for
 * permission names and states is uneven, queries may reject for unsupported or
 * invalid descriptors, and some permissions are only meaningful in secure
 * contexts or after user activation. Returned `PermissionStatus` objects can
 * change when the user updates browser settings or responds to prompts; when
 * watching `change` or `onchange`, account for browser differences and clean up
 * listeners when the surrounding Effect scope ends.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const TypeId = "~@effect/platform-browser/Permissions"
const ErrorTypeId = "~@effect/platform-browser/Permissions/PermissionsError"

/**
 * Wrapper on the Permission API (`navigator.permissions`) with methods for
 * querying status of permissions.
 *
 * @category models
 * @since 4.0.0
 */
export interface Permissions {
  readonly [TypeId]: typeof TypeId

  /**
   * Returns the state of a user permission on the global scope.
   */
  readonly query: <Name extends PermissionName>(
    name: Name
  ) => Effect.Effect<
    // `name` is identical to the name passed to Permissions.query
    // https://developer.mozilla.org/en-US/docs/Web/API/PermissionStatus
    Omit<PermissionStatus, "name"> & { name: Name },
    PermissionsError
  >
}

/**
 * Error reason for an `InvalidStateError` raised by the browser Permissions API.
 *
 * @category errors
 * @since 4.0.0
 */
export class PermissionsInvalidStateError extends Data.TaggedError("InvalidStateError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * Error reason for a `TypeError` raised by the browser Permissions API.
 *
 * @category errors
 * @since 4.0.0
 */
export class PermissionsTypeError extends Data.TaggedError("TypeError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * Union of browser Permissions API error reasons represented by the service.
 *
 * @category errors
 * @since 4.0.0
 */
export type PermissionsErrorReason = PermissionsInvalidStateError | PermissionsTypeError

/**
 * Tagged error wrapping a browser Permissions API failure reason.
 *
 * @category errors
 * @since 4.0.0
 */
export class PermissionsError extends Data.TaggedError("PermissionsError")<{
  readonly reason: PermissionsErrorReason
}> {
  constructor(props: { readonly reason: PermissionsErrorReason }) {
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
 * Service tag for the browser `Permissions` service.
 *
 * @category services
 * @since 4.0.0
 */
export const Permissions: Context.Service<Permissions, Permissions> = Context.Service<Permissions>(TypeId)

/**
 * A layer that directly interfaces with the `navigator.permissions` api
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Permissions> = Layer.succeed(
  Permissions,
  Permissions.of({
    [TypeId]: TypeId,
    query: (name) =>
      Effect.tryPromise({
        try: () => navigator.permissions.query({ name }) as Promise<any>,
        catch: (cause) =>
          new PermissionsError({
            reason: cause instanceof DOMException
              ? new PermissionsInvalidStateError({ cause })
              : new PermissionsTypeError({ cause })
          })
      })
  })
)
