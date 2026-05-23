/**
 * Shared Node-compatible implementation of Effect's `Path` service.
 *
 * This module adapts Node's `node:path` and `node:url` APIs into layers that
 * can be provided to Effect programs needing path manipulation, such as
 * resolving configuration files, building file system locations, parsing
 * names and extensions, or converting between file paths and `file:` URLs.
 *
 * The default layer follows the host platform semantics exposed by
 * `node:path`, while `layerPosix` and `layerWin32` provide stable POSIX or
 * Windows behavior regardless of the current runtime. Path operations are
 * syntactic and do not check whether files exist; separators, drive letters,
 * UNC paths, and URL encoding rules can also differ by platform. Invalid
 * file URL conversions are reported through `BadArgument`.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Path, TypeId } from "effect/Path"
import { BadArgument } from "effect/PlatformError"
import * as NodePath from "node:path"
import * as NodeUrl from "node:url"

const fromFileUrl = (url: URL): Effect.Effect<string, BadArgument> =>
  Effect.try({
    try: () => NodeUrl.fileURLToPath(url),
    catch: (cause) =>
      new BadArgument({
        module: "Path",
        method: "fromFileUrl",
        cause
      })
  })

const toFileUrl = (path: string): Effect.Effect<URL, BadArgument> =>
  Effect.try({
    try: () => NodeUrl.pathToFileURL(path),
    catch: (cause) =>
      new BadArgument({
        module: "Path",
        method: "toFileUrl",
        cause
      })
  })

/**
 * Provides the `Path` service using Node's POSIX path implementation plus
 * file URL conversion helpers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerPosix: Layer.Layer<Path> = Layer.succeed(Path)({
  [TypeId]: TypeId,
  ...NodePath.posix,
  fromFileUrl,
  toFileUrl
})

/**
 * Provides the `Path` service using Node's Windows path implementation plus
 * file URL conversion helpers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWin32: Layer.Layer<Path> = Layer.succeed(Path)({
  [TypeId]: TypeId,
  ...NodePath.win32,
  fromFileUrl,
  toFileUrl
})

/**
 * Provides the default `Path` service using the host platform's Node path
 * implementation plus file URL conversion helpers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Path> = Layer.succeed(Path)({
  [TypeId]: TypeId,
  ...NodePath,
  fromFileUrl,
  toFileUrl
})
