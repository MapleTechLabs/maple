/**
 * Browser platform implementation of the Crypto service.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import * as EffectCrypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"

/**
 * Browser Web Crypto APIs used by the Crypto service implementation.
 *
 * @category models
 * @since 1.0.0
 */
export const WebCrypto = Context.Reference<Crypto>("@effect/platform-browser/Crypto/WebCrypto", {
  defaultValue: () => globalThis.crypto
})

/**
 * A layer that directly interfaces with the Web Crypto API.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<EffectCrypto.Crypto> = Layer.effect(
  EffectCrypto.Crypto,
  Effect.gen(function*() {
    const crypto = yield* WebCrypto
    if (!crypto) {
      return yield* Effect.die(new Error("Web Crypto API is not available"))
    }
    const randomBytes = (size: number): Uint8Array => {
      const bytes = new Uint8Array(size)
      crypto.getRandomValues(bytes)
      return bytes
    }

    const digest: EffectCrypto.Crypto["digest"] = (algorithm, data) => {
      if (typeof crypto.subtle.digest !== "function") {
        return Effect.fail(PlatformError.systemError({
          module: "Crypto",
          method: "digest",
          _tag: "Unknown",
          description: "crypto.subtle.digest is not available"
        }))
      }
      return Effect.map(
        Effect.tryPromise({
          try: () => crypto.subtle.digest(algorithm, new Uint8Array(data)),
          catch: (cause) =>
            PlatformError.systemError({
              module: "Crypto",
              method: "digest",
              _tag: "Unknown",
              description: "Could not compute digest",
              cause
            })
        }),
        (buffer) => new Uint8Array(buffer)
      )
    }

    return EffectCrypto.make({
      randomBytes,
      digest
    })
  })
)
