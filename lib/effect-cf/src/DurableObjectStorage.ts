import { Data, Effect, Exit, Option, Schema as S } from "effect";

/** Supported primitive value types for Durable Object SQL APIs. */
export type SqlStorageValue = globalThis.SqlStorageValue;

/** Error type used when a storage operation throws or rejects. */
export class StorageOperationError extends Data.TaggedError("StorageOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type StorageEffect<A> = Effect.Effect<A, StorageOperationError>;

/**
 * Effect wrapper for Cloudflare SQL cursor operations.
 */
export interface SqlCursor<T extends Record<string, SqlStorageValue>> {
  next(): StorageEffect<{ done?: false; value: T } | { done: true; value?: never }>;
  toArray(): StorageEffect<Array<T>>;
  one(): StorageEffect<T>;
  raw<U extends Array<SqlStorageValue>>(): StorageEffect<IterableIterator<U>>;
  readonly columnNames: Array<string>;
  readonly rowsRead: StorageEffect<number>;
  readonly rowsWritten: StorageEffect<number>;
}

/**
 * Effect wrapper for Durable Object SQLite APIs.
 */
export interface SqlStorage {
  /** Executes a SQL statement and returns a typed cursor. */
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: Array<SqlStorageValue>
  ): StorageEffect<SqlCursor<T>>;
  readonly databaseSize: number;
}

/**
 * Schema pair used by `SyncKvStorage.schema(...)`.
 */
export interface SyncKvDefinition<Key, Value, EncodedValue> {
  readonly key: S.Codec<Key, string>;
  readonly value: S.Codec<Value, EncodedValue>;
}

/**
 * Sync KV wrapper that transparently encodes keys/values through Effect Schema.
 */
export interface SchemaBackedSyncKvStorage<Key, Value> {
  get(key: Key): Effect.Effect<Option.Option<Value>, unknown>;
  put(key: Key, value: Value): Effect.Effect<void, unknown>;
  delete(key: Key): Effect.Effect<boolean, unknown>;
  list(options?: globalThis.SyncKvListOptions): Effect.Effect<Array<[Key, Value]>, unknown>;
}

/**
 * Effect wrapper for synchronous KV attached to Durable Object SQLite storage.
 */
export interface SyncKvStorage {
  get<T = unknown>(key: string): StorageEffect<T | undefined>;
  put<T>(key: string, value: T): StorageEffect<void>;
  delete(key: string): StorageEffect<boolean>;
  list<T = unknown>(options?: globalThis.SyncKvListOptions): StorageEffect<Array<[string, T]>>;
  schema<Key, Value, EncodedValue>(
    definition: SyncKvDefinition<Key, Value, EncodedValue>,
  ): SchemaBackedSyncKvStorage<Key, Value>;
}

/**
 * Effect wrapper around Cloudflare transaction callbacks.
 */
export interface DurableObjectTransaction {
  get<T = unknown>(
    key: string,
    options?: globalThis.DurableObjectGetOptions,
  ): StorageEffect<T | undefined>;
  get<T = unknown>(
    keys: Array<string>,
    options?: globalThis.DurableObjectGetOptions,
  ): StorageEffect<Map<string, T>>;
  list<T = unknown>(options?: globalThis.DurableObjectListOptions): StorageEffect<Map<string, T>>;
  put<T>(key: string, value: T, options?: globalThis.DurableObjectPutOptions): StorageEffect<void>;
  put<T>(
    entries: Record<string, T>,
    options?: globalThis.DurableObjectPutOptions,
  ): StorageEffect<void>;
  delete(key: string, options?: globalThis.DurableObjectPutOptions): StorageEffect<boolean>;
  delete(keys: Array<string>, options?: globalThis.DurableObjectPutOptions): StorageEffect<number>;
  rollback(): StorageEffect<void>;
  getAlarm(options?: globalThis.DurableObjectGetAlarmOptions): StorageEffect<number | null>;
  setAlarm(
    scheduledTime: number | Date,
    options?: globalThis.DurableObjectSetAlarmOptions,
  ): StorageEffect<void>;
  deleteAlarm(options?: globalThis.DurableObjectSetAlarmOptions): StorageEffect<void>;
}

/**
 * Effect wrapper around Cloudflare Durable Object storage.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const state = yield* DurableObjectState;
 *   yield* state.storage.put("counter", 1);
 *   const value = yield* state.storage.get<number>("counter");
 *   return value;
 * });
 * ```
 */
export interface DurableObjectStorage {
  get<T = unknown>(
    key: string,
    options?: globalThis.DurableObjectGetOptions,
  ): StorageEffect<T | undefined>;
  put<T>(key: string, value: T, options?: globalThis.DurableObjectPutOptions): StorageEffect<void>;
  delete(key: string, options?: globalThis.DurableObjectPutOptions): StorageEffect<boolean>;
  /**
   * Deletes all stored data. On compatibility dates before 2026-02-24, Cloudflare
   * documents that active alarms must be deleted separately with `deleteAlarm()`.
   */
  deleteAll(options?: globalThis.DurableObjectPutOptions): StorageEffect<void>;
  getAlarm(options?: globalThis.DurableObjectGetAlarmOptions): StorageEffect<number | null>;
  setAlarm(
    scheduledTime: number | Date,
    options?: globalThis.DurableObjectSetAlarmOptions,
  ): StorageEffect<void>;
  deleteAlarm(options?: globalThis.DurableObjectSetAlarmOptions): StorageEffect<void>;
  /**
   * SQLite-backed Durable Object storage only.
   *
   * The callback Effect must complete synchronously. If it requires asynchronous
   * work, use `transaction` instead so Cloudflare can run the async transaction
   * callback under the platform's transaction contract.
   */
  transactionSync<A, E, R>(
    closure: () => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | StorageOperationError, R>;
  /**
   * Runs an async transaction and exposes a typed transaction wrapper.
   */
  transaction<A, E, R>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | StorageOperationError, R>;
  /** Flushes pending writes to disk. */
  sync(): StorageEffect<void>;
  /** SQLite-backed Durable Object storage point-in-time recovery API only. */
  getCurrentBookmark(): StorageEffect<string>;
  /** SQLite-backed Durable Object storage point-in-time recovery API only. */
  onNextSessionRestoreBookmark(bookmark: string): StorageEffect<string>;
  readonly sql: SqlStorage;
  readonly kv: SyncKvStorage;
}

const storageError = (operation: string, cause: unknown) =>
  new StorageOperationError({ operation, cause });

const tryStorageSync = <A>(operation: string, evaluate: () => A): StorageEffect<A> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => storageError(operation, cause),
  });

const tryStoragePromise = <A>(operation: string, evaluate: () => Promise<A>): StorageEffect<A> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => storageError(operation, cause),
  });

const fromSqlCursor = <T extends Record<string, SqlStorageValue>>(
  cursor: globalThis.SqlStorageCursor<T>,
): SqlCursor<T> => ({
  next: () => tryStorageSync("sql.next", () => cursor.next()),
  toArray: () => tryStorageSync("sql.toArray", () => cursor.toArray()),
  one: () => tryStorageSync("sql.one", () => cursor.one()),
  raw: <U extends Array<SqlStorageValue>>() => tryStorageSync("sql.raw", () => cursor.raw<U>()),
  get columnNames() {
    return cursor.columnNames;
  },
  rowsRead: tryStorageSync("sql.rowsRead", () => cursor.rowsRead),
  rowsWritten: tryStorageSync("sql.rowsWritten", () => cursor.rowsWritten),
});

const fromSqlStorage = (sql: globalThis.SqlStorage): SqlStorage => ({
  exec: <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: Array<SqlStorageValue>
  ) => tryStorageSync("sql.exec", () => fromSqlCursor(sql.exec<T>(query, ...bindings))),
  get databaseSize() {
    return sql.databaseSize;
  },
});

const schemaBackedSyncKvStorage = <Key, Value, EncodedValue>(
  kv: globalThis.SyncKvStorage,
  definition: SyncKvDefinition<Key, Value, EncodedValue>,
): SchemaBackedSyncKvStorage<Key, Value> => {
  const encodeKey = S.encodeEffect(definition.key);
  const decodeKey = S.decodeUnknownEffect(definition.key);
  const encodeValue = S.encodeEffect(definition.value);
  const decodeValue = S.decodeUnknownEffect(definition.value);

  return {
    get: (key) =>
      Effect.gen(function* () {
        const encodedKey = yield* encodeKey(key);
        const encodedValue = yield* tryStorageSync("kv.get", () =>
          kv.get<EncodedValue>(encodedKey),
        );

        if (encodedValue === undefined) {
          return Option.none();
        }

        return yield* decodeValue(encodedValue).pipe(Effect.map(Option.some));
      }),
    put: (key, value) =>
      Effect.gen(function* () {
        const encodedKey = yield* encodeKey(key);
        const encodedValue = yield* encodeValue(value);
        yield* tryStorageSync("kv.put", () => kv.put(encodedKey, encodedValue));
      }),
    delete: (key) =>
      Effect.gen(function* () {
        const encodedKey = yield* encodeKey(key);
        return yield* tryStorageSync("kv.delete", () => kv.delete(encodedKey));
      }),
    list: (options) =>
      Effect.gen(function* () {
        const entries = Array.from(
          yield* tryStorageSync("kv.list", () => kv.list<EncodedValue>(options)),
        );
        const decoded: Array<[Key, Value]> = [];

        for (const [key, value] of entries) {
          decoded.push([yield* decodeKey(key), yield* decodeValue(value)]);
        }

        return decoded;
      }),
  };
};

const fromSyncKvStorage = (kv: globalThis.SyncKvStorage): SyncKvStorage => ({
  get: <T = unknown>(key: string) => tryStorageSync("kv.get", () => kv.get<T>(key)),
  put: <T>(key: string, value: T) => tryStorageSync("kv.put", () => kv.put(key, value)),
  delete: (key: string) => tryStorageSync("kv.delete", () => kv.delete(key)),
  list: <T = unknown>(options?: globalThis.SyncKvListOptions) =>
    tryStorageSync("kv.list", () => Array.from(kv.list<T>(options))),
  schema: <Key, Value, EncodedValue>(definition: SyncKvDefinition<Key, Value, EncodedValue>) =>
    schemaBackedSyncKvStorage(kv, definition),
});

const fromDurableObjectTransaction = (
  txn: globalThis.DurableObjectTransaction,
): DurableObjectTransaction =>
  ({
    get: <T = unknown>(
      keyOrKeys: string | Array<string>,
      options?: globalThis.DurableObjectGetOptions,
    ) =>
      Array.isArray(keyOrKeys)
        ? tryStoragePromise("transaction.get", () => txn.get<T>(keyOrKeys, options))
        : tryStoragePromise("transaction.get", () => txn.get<T>(keyOrKeys, options)),
    list: <T = unknown>(options?: globalThis.DurableObjectListOptions) =>
      tryStoragePromise("transaction.list", () => txn.list<T>(options)),
    put: <T>(
      keyOrEntries: string | Record<string, T>,
      valueOrOptions?: T | globalThis.DurableObjectPutOptions,
      maybeOptions?: globalThis.DurableObjectPutOptions,
    ) =>
      tryStoragePromise("transaction.put", () =>
        typeof keyOrEntries === "string"
          ? txn.put(keyOrEntries, valueOrOptions as T, maybeOptions)
          : txn.put(keyOrEntries, valueOrOptions as globalThis.DurableObjectPutOptions | undefined),
      ),
    delete: (keyOrKeys: string | Array<string>, options?: globalThis.DurableObjectPutOptions) =>
      Array.isArray(keyOrKeys)
        ? tryStoragePromise("transaction.delete", () => txn.delete(keyOrKeys, options))
        : tryStoragePromise("transaction.delete", () => txn.delete(keyOrKeys, options)),
    rollback: () => tryStorageSync("transaction.rollback", () => txn.rollback()),
    getAlarm: (options?: globalThis.DurableObjectGetAlarmOptions) =>
      tryStoragePromise("transaction.getAlarm", () => txn.getAlarm(options)),
    setAlarm: (scheduledTime: number | Date, options?: globalThis.DurableObjectSetAlarmOptions) =>
      tryStoragePromise("transaction.setAlarm", () => txn.setAlarm(scheduledTime, options)),
    deleteAlarm: (options?: globalThis.DurableObjectSetAlarmOptions) =>
      tryStoragePromise("transaction.deleteAlarm", () => txn.deleteAlarm(options)),
  }) as DurableObjectTransaction;

/**
 * Wraps native Cloudflare storage APIs as Effect-returning helpers.
 */
export const fromDurableObjectStorage = (
  storage: globalThis.DurableObjectStorage,
): DurableObjectStorage => ({
  get: <T = unknown>(key: string, options?: globalThis.DurableObjectGetOptions) =>
    tryStoragePromise("get", () => storage.get<T>(key, options)),
  put: <T>(key: string, value: T, options?: globalThis.DurableObjectPutOptions) =>
    tryStoragePromise("put", () => storage.put(key, value, options)),
  delete: (key: string, options?: globalThis.DurableObjectPutOptions) =>
    tryStoragePromise("delete", () => storage.delete(key, options)),
  deleteAll: (options?: globalThis.DurableObjectPutOptions) =>
    tryStoragePromise("deleteAll", () => storage.deleteAll(options)),
  getAlarm: (options?: globalThis.DurableObjectGetAlarmOptions) =>
    tryStoragePromise("getAlarm", () => storage.getAlarm(options)),
  setAlarm: (scheduledTime: number | Date, options?: globalThis.DurableObjectSetAlarmOptions) =>
    tryStoragePromise("setAlarm", () => storage.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: globalThis.DurableObjectSetAlarmOptions) =>
    tryStoragePromise("deleteAlarm", () => storage.deleteAlarm(options)),
  transactionSync: <A, E, R>(closure: () => Effect.Effect<A, E, R>) =>
    Effect.context<R>().pipe(
      Effect.flatMap((context) =>
        Effect.suspend(() => {
          try {
            return Effect.succeed(
              storage.transactionSync(() => {
                const exit = Effect.runSyncExitWith(context)(closure());

                if (Exit.isSuccess(exit)) {
                  return exit.value;
                }

                throw exit;
              }),
            );
          } catch (cause) {
            if (Exit.isExit(cause) && Exit.isFailure(cause)) {
              return Effect.failCause(cause.cause) as Effect.Effect<
                A,
                E | StorageOperationError,
                R
              >;
            }

            return Effect.fail(storageError("transactionSync", cause));
          }
        }),
      ),
    ),
  transaction: <A, E, R>(closure: (txn: DurableObjectTransaction) => Effect.Effect<A, E, R>) =>
    Effect.context<R>().pipe(
      Effect.flatMap((context) =>
        Effect.callback<A, E | StorageOperationError>((resume) => {
          void storage
            .transaction(async (txn) => {
              const exit = await Effect.runPromiseExitWith(context)(
                closure(fromDurableObjectTransaction(txn)),
              );

              if (Exit.isSuccess(exit)) {
                return exit.value;
              }

              throw exit;
            })
            .then(
              (value) => resume(Effect.succeed(value)),
              (cause) => {
                if (Exit.isExit(cause) && Exit.isFailure(cause)) {
                  resume(
                    Effect.failCause(cause.cause) as Effect.Effect<A, E | StorageOperationError>,
                  );
                } else {
                  resume(Effect.fail(storageError("transaction", cause)));
                }
              },
            );
        }),
      ),
    ),
  sync: () => tryStoragePromise("sync", () => storage.sync()),
  getCurrentBookmark: () =>
    tryStoragePromise("getCurrentBookmark", () => storage.getCurrentBookmark()),
  onNextSessionRestoreBookmark: (bookmark: string) =>
    tryStoragePromise("onNextSessionRestoreBookmark", () =>
      storage.onNextSessionRestoreBookmark(bookmark),
    ),
  sql: fromSqlStorage(storage.sql),
  kv: fromSyncKvStorage(storage.kv),
});
