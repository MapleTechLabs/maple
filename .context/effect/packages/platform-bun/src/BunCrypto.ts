/**
 * Bun platform Crypto service layer.
 *
 * @since 1.0.0
 */
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import type * as Crypto from "effect/Crypto"
import type * as Layer from "effect/Layer"

/**
 * A layer that provides the Bun Crypto service implementation.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Crypto.Crypto> = NodeCrypto.layer
