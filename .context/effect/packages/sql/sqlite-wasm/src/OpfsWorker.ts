/**
 * Worker-side entry point for SQLite WASM databases stored in the browser
 * Origin Private File System.
 *
 * This module opens `@effect/wa-sqlite` with the OPFS access-handle VFS and
 * serves the message protocol used by `SqliteClient.make`. Run it from a
 * dedicated worker, or from a `SharedWorker` connection port, when an
 * application needs durable local SQLite storage for local-first data, offline
 * caches, client-side migrations, or import/export workflows that keep the
 * database off the main thread.
 *
 * The worker owns the SQLite connection for the lifetime of `run`: it posts a
 * `ready` message after opening the database, responds to query, import,
 * export, and update-hook messages, and releases the database when the client
 * sends `close` or the surrounding scope is interrupted. Because OPFS support
 * depends on the browser and origin, applications should start this worker only
 * in supported secure contexts, close unused ports so access handles are
 * released, and coordinate multiple tabs or workers before opening or migrating
 * the same OPFS database.
 *
 * @since 4.0.0
 */
/// <reference lib="webworker" />
// oxlint-disable-next-line effect/no-import-from-barrel-package
import * as WaSqlite from "@effect/wa-sqlite"
import SQLiteESMFactory from "@effect/wa-sqlite/dist/wa-sqlite.mjs"
import { AccessHandlePoolVFS } from "@effect/wa-sqlite/src/examples/AccessHandlePoolVFS.js"
import * as Effect from "effect/Effect"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import type { OpfsWorkerMessage } from "./internal/opfsWorker.ts"

const classifyError = (cause: unknown, message: string, operation: string) =>
  classifySqliteError(cause, { message, operation })

/**
 * Configuration for the SQLite OPFS worker, including the message port used for the client protocol and the OPFS database name to open.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpfsWorkerConfig {
  readonly port: EventTarget & Pick<MessagePort, "postMessage" | "close">
  readonly dbName: string
}

/**
 * Runs the SQLite OPFS worker loop, opening the configured database, posting a ready message, handling query/import/export/update-hook messages, and closing when a close message is received.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run = (
  options: OpfsWorkerConfig
): Effect.Effect<void, SqlError> =>
  Effect.gen(function*() {
    const factory = yield* Effect.promise(() => SQLiteESMFactory())
    const sqlite3 = WaSqlite.Factory(factory)
    const vfs = yield* Effect.promise(() => AccessHandlePoolVFS.create("opfs", factory))
    sqlite3.vfs_register(vfs, false)
    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () => sqlite3.open_v2(options.dbName, undefined, "opfs"),
        catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to open database", "openDatabase") })
      }),
      (db) => Effect.sync(() => sqlite3.close(db))
    )

    return yield* Effect.callback<void>((resume) => {
      const onMessage = (event: any) => {
        let messageId: number
        const message = event.data as OpfsWorkerMessage
        try {
          switch (message[0]) {
            case "close": {
              options.port.close()
              return resume(Effect.void)
            }
            case "import": {
              const [, id, data] = message
              messageId = id
              sqlite3.deserialize(db, "main", data, data.length, data.length, 1 | 2)
              options.port.postMessage([id, void 0, void 0])
              return
            }
            case "export": {
              const [, id] = message
              messageId = id
              const data = sqlite3.serialize(db, "main")
              options.port.postMessage([id, undefined, data], [data.buffer])
              return
            }
            case "update_hook": {
              messageId = -1
              sqlite3.update_hook(db, (_op, _db, table, rowid) => {
                if (!table) return
                options.port.postMessage(["update_hook", table, Number(rowid)])
              })
              return
            }
            default: {
              const [id, sql, params] = message
              messageId = id
              const results: Array<any> = []
              let columns: Array<string> | undefined
              for (const stmt of sqlite3.statements(db, sql)) {
                sqlite3.bind_collection(stmt, params as any)
                while (sqlite3.step(stmt) === WaSqlite.SQLITE_ROW) {
                  columns = columns ?? sqlite3.column_names(stmt)
                  const row = sqlite3.row(stmt)
                  results.push(row)
                }
              }
              options.port.postMessage([id, undefined, [columns, results]])
              return
            }
          }
        } catch (e: any) {
          const message = "message" in e ? e.message : String(e)
          options.port.postMessage([messageId!, message, undefined])
        }
      }
      options.port.addEventListener("message", onMessage)
      options.port.postMessage(["ready", undefined, undefined])
      return Effect.sync(() => {
        options.port.removeEventListener("message", onMessage)
      })
    })
  }).pipe(Effect.scoped)
