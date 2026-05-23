/**
 * Provides the aggregate Node platform services layer for applications that run
 * on the Node.js runtime.
 *
 * This module is useful when an application needs the standard Node-backed
 * implementations of filesystem access, path operations, stdio, terminal
 * interaction, and child process spawning from a single layer. Provide
 * `NodeServices.layer` near the edge of a program to satisfy effects that read
 * or write files, resolve paths, interact with stdin/stdout/stderr or a
 * terminal, or launch subprocesses.
 *
 * The layer only supplies the runtime services listed by `NodeServices`; it does
 * not provide unrelated platform services such as HTTP clients or servers.
 * Libraries should continue to depend on the individual service tags they use,
 * while applications, CLIs, and tests can choose this layer or narrower
 * service-specific layers depending on how much of the Node runtime they want to
 * expose.
 *
 * @since 4.0.0
 */
import type { Crypto } from "effect/Crypto"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type { Path } from "effect/Path"
import type { Stdio } from "effect/Stdio"
import type { Terminal } from "effect/Terminal"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcessSpawner from "./NodeChildProcessSpawner.ts"
import * as NodeCrypto from "./NodeCrypto.ts"
import * as NodeFileSystem from "./NodeFileSystem.ts"
import * as NodePath from "./NodePath.ts"
import * as NodeStdio from "./NodeStdio.ts"
import * as NodeTerminal from "./NodeTerminal.ts"

/**
 * The union of core services provided by the Node platform layer, including
 * child process spawning, filesystem, path, stdio, and terminal services.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeServices = ChildProcessSpawner | Crypto | FileSystem | Path | Stdio | Terminal

/**
 * Provides the default Node implementations for child process spawning,
 * filesystem, path, stdio, and terminal services.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<NodeServices> = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(
    NodeFileSystem.layer,
    NodeCrypto.layer,
    NodePath.layer,
    NodeStdio.layer,
    NodeTerminal.layer
  )
)
