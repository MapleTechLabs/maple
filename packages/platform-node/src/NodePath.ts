/**
 * Node.js layers for Effect's `Path` service.
 *
 * Use this module when an Effect program running on Node needs path operations
 * from the `Path` service, such as joining and normalizing filesystem
 * locations, resolving configuration or static asset paths, working with CLI
 * path arguments, or converting between file paths and `file:` URLs.
 *
 * `layer` follows the host platform's `node:path` semantics. Use `layerPosix`
 * or `layerWin32` when code needs stable POSIX or Windows behavior regardless
 * of the operating system. These layers provide only path manipulation; they do
 * not read the filesystem or validate that paths exist. `NodeServices.layer`
 * already includes the default Node path layer, so provide this module directly
 * when you want the narrower service or one of the platform-specific variants.
 *
 * @since 4.0.0
 */
import * as NodePath from "@effect/platform-node-shared/NodePath"
import type * as Layer from "effect/Layer"
import type { Path } from "effect/Path"

/**
 * Provides the default Node `Path` service using the platform's `node:path`
 * implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Path> = NodePath.layer

/**
 * Provides the `Path` service using Node's POSIX path implementation,
 * regardless of the host platform.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerPosix: Layer.Layer<Path> = NodePath.layerPosix

/**
 * Provides the `Path` service using Node's Windows path implementation,
 * regardless of the host platform.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWin32: Layer.Layer<Path> = NodePath.layerWin32
