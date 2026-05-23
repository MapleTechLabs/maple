/**
 * Provides the Node.js `FileSystem` layer for Effect programs.
 *
 * Use this module when a Node application, CLI, script, or test needs to
 * satisfy the `FileSystem` service with real filesystem access for reading and
 * writing files, creating directories and temporary files, inspecting metadata,
 * managing links, or watching paths for changes.
 *
 * This module only exposes the Node-backed layer; filesystem operations are
 * accessed through the `FileSystem` service from `effect/FileSystem`. Provide
 * `NodeFileSystem.layer` at the edge of the program, or use
 * `NodeServices.layer` when you also want the standard Node path, stdio,
 * terminal, and child process services. The implementation is shared with
 * other Node-compatible platform packages, so optional services such as
 * `FileSystem.WatchBackend` are honored when present; otherwise file watching
 * follows Node's `node:fs.watch` behavior. Paths are interpreted by Node, so
 * relative paths use the current working directory and platform path rules.
 *
 * @since 4.0.0
 */
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import type { FileSystem } from "effect/FileSystem"
import type * as Layer from "effect/Layer"

/**
 * Provides the `FileSystem` service backed by Node filesystem APIs.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<FileSystem> = NodeFileSystem.layer
