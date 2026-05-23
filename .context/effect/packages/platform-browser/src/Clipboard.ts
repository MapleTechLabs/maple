/**
 * Browser clipboard service for Effect programs.
 *
 * This module wraps the browser `navigator.clipboard` API in a `Clipboard`
 * service so client-side applications can read, write, and clear clipboard
 * contents as typed Effects. It is useful for common UI workflows such as copy
 * buttons, paste/import actions, sharing generated text, and moving rich
 * clipboard payloads like `Blob`-backed `ClipboardItem`s through an Effect
 * environment.
 *
 * Browser clipboard rules still apply. Clipboard access generally requires a
 * secure context, and browsers may require a user gesture, permission prompt, or
 * active focused document before reads or writes are allowed. Support also
 * varies by operation and payload type: text helpers are the most portable,
 * while `ClipboardItem` and non-text MIME types may be unavailable or restricted
 * in some browsers. Failed browser operations are surfaced as `ClipboardError`.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const TypeId = "~@effect/platform-browser/Clipboard"
const ErrorTypeId = "~@effect/platform-browser/Clipboard/ClipboardError"

/**
 * Service interface for reading from, writing to, and clearing the browser clipboard.
 *
 * @category models
 * @since 4.0.0
 */
export interface Clipboard {
  readonly [TypeId]: typeof TypeId
  readonly read: Effect.Effect<ClipboardItems, ClipboardError>
  readonly readString: Effect.Effect<string, ClipboardError>
  readonly write: (items: ClipboardItems) => Effect.Effect<void, ClipboardError>
  readonly writeString: (text: string) => Effect.Effect<void, ClipboardError>
  readonly writeBlob: (blob: Blob) => Effect.Effect<void, ClipboardError>
  readonly clear: Effect.Effect<void, ClipboardError>
}

/**
 * Tagged error raised when a browser clipboard operation fails.
 *
 * @category errors
 * @since 4.0.0
 */
export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly message: string
  readonly cause: unknown
}> {
  readonly [ErrorTypeId] = ErrorTypeId
}

/**
 * Service tag for the browser `Clipboard` service.
 *
 * @category services
 * @since 4.0.0
 */
export const Clipboard: Context.Service<Clipboard, Clipboard> = Context.Service<Clipboard>(TypeId)

/**
 * Builds a `Clipboard` service from primitive read and write operations, deriving `clear` and `writeBlob` helpers.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  impl: Omit<Clipboard, "clear" | "writeBlob" | typeof TypeId>
): Clipboard =>
  Clipboard.of({
    ...impl,
    [TypeId]: TypeId,
    clear: impl.writeString(""),
    writeBlob: (blob: Blob) => impl.write([new ClipboardItem({ [blob.type]: blob })])
  })

/**
 * A layer that directly interfaces with the navigator.clipboard api
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Clipboard> = Layer.succeed(
  Clipboard,
  make({
    read: Effect.tryPromise({
      try: () => navigator.clipboard.read(),
      catch: (cause) =>
        new ClipboardError({
          cause,
          "message": "Unable to read from clipboard"
        })
    }),
    write: (s: Array<ClipboardItem>) =>
      Effect.tryPromise({
        try: () => navigator.clipboard.write(s),
        catch: (cause) =>
          new ClipboardError({
            cause,
            "message": "Unable to write to clipboard"
          })
      }),
    readString: Effect.tryPromise({
      try: () => navigator.clipboard.readText(),
      catch: (cause) =>
        new ClipboardError({
          cause,
          "message": "Unable to read a string from clipboard"
        })
    }),
    writeString: (text: string) =>
      Effect.tryPromise({
        try: () => navigator.clipboard.writeText(text),
        catch: (cause) =>
          new ClipboardError({
            cause,
            "message": "Unable to write a string to clipboard"
          })
      })
  })
)
