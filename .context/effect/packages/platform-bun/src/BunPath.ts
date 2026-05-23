/**
 * Bun layers for Effect's `Path` service.
 *
 * Use this module when an Effect program running on Bun needs path
 * manipulation from the `Path` service, such as joining and normalizing local
 * filesystem locations, resolving configuration or static asset paths, handling
 * CLI path arguments, or converting between filesystem paths and `file:` URLs.
 *
 * Bun exposes Node-compatible path behavior, so these layers reuse the shared
 * Node path implementation. The default `layer` follows the host operating
 * system's path rules, including separators, absolute paths, drive letters, and
 * UNC paths where applicable. Use `layerPosix` or `layerWin32` when code needs
 * stable POSIX or Windows semantics regardless of where Bun is running. These
 * layers only manipulate path strings; they do not read the filesystem, validate
 * that paths exist, or turn request URLs into safe local paths. `BunServices`
 * already includes the default Bun path layer, so provide this module directly
 * when you need only `Path` or one of the platform-specific variants.
 *
 * @since 4.0.0
 */
import * as NodePath from "@effect/platform-node-shared/NodePath"
import type * as Layer from "effect/Layer"
import type { Path } from "effect/Path"

/**
 * Layer that provides the default `Path` service for Bun using the shared Node path implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Path> = NodePath.layer

/**
 * Layer that provides the POSIX `Path` service for Bun using the shared Node path implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerPosix: Layer.Layer<Path> = NodePath.layerPosix

/**
 * Layer that provides the Win32 `Path` service for Bun using the shared Node path implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWin32: Layer.Layer<Path> = NodePath.layerWin32
