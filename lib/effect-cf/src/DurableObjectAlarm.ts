import { Clock, Context, Data, DateTime, Duration, Effect, Exit, Layer, Schema as S } from "effect";

import { DurableObjectState } from "./DurableObjectState";
import type { SqlStorageValue, StorageOperationError } from "./DurableObjectStorage";

const INIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS effect_cf_scheduled_alarms (
  storage_id TEXT PRIMARY KEY,
  alarm_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  repeat_every_ms INTEGER,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effect_cf_scheduled_alarms_run_at_storage_id
  ON effect_cf_scheduled_alarms (run_at, storage_id);
`;

const DEFAULT_PROCESS_DUE_ALARMS_LIMIT = 100;
const DEFAULT_PROCESS_DUE_ALARMS_FAILURE_RESCHEDULE_AFTER = "30 seconds" satisfies Duration.Input;

const getScheduledEventId = (input: { readonly id: string; readonly tag: string }) =>
  `effect-cf-alarm:${encodeURIComponent(input.tag)}:${encodeURIComponent(input.id)}`;

/**
 * JSON-serializable alarm payload stored with each scheduled alarm.
 *
 * Payloads are intentionally opaque to `DurableObjectAlarm`. Consumers should use
 * stable `tag` values to route due alarms and then decode the payload for that
 * tag in their own domain layer.
 */
export type AlarmPayload = S.Json;

interface AlarmRow extends Record<string, SqlStorageValue> {
  readonly alarm_id: string;
  readonly payload: string;
  readonly repeat_every_ms: number | null;
  readonly run_at: number;
  readonly storage_id: string;
  readonly tag: string;
}

interface NextAlarmRow extends Record<string, SqlStorageValue> {
  readonly run_at: number;
}

export class InvalidAlarmRefError extends Data.TaggedError("InvalidAlarmRefError")<{
  readonly cause: unknown;
}> {}

export class InvalidAlarmPayloadError extends Data.TaggedError("InvalidAlarmPayloadError")<{
  readonly cause: unknown;
}> {}

export class InvalidRepeatEveryError extends Data.TaggedError("InvalidRepeatEveryError")<{
  readonly cause: unknown;
}> {}

export class InvalidProcessDueAlarmsOptionsError extends Data.TaggedError(
  "InvalidProcessDueAlarmsOptionsError",
)<{
  readonly cause: unknown;
}> {}

export class StoredAlarmDecodeError extends Data.TaggedError("StoredAlarmDecodeError")<{
  readonly cause: unknown;
  readonly storageId: string;
}> {}

export type DurableObjectAlarmError =
  | InvalidAlarmPayloadError
  | InvalidAlarmRefError
  | InvalidProcessDueAlarmsOptionsError
  | InvalidRepeatEveryError
  | StorageOperationError
  | StoredAlarmDecodeError;

/**
 * Events handled by `processDueAlarms`.
 *
 * `AlarmDue` represents one durable alarm whose scheduled time is now due. The
 * `tag` is the consumer-owned routing key, while `id` is the stable alarm id
 * within that tag.
 *
 * `scheduledAt` is the logical due-after timestamp from durable storage. It is
 * not expected to match the current Durable Object alarm invocation time,
 * especially during retries. Retries re-scan durable rows with `run_at <= now`
 * and identify logical events by `{ tag, id }`.
 *
 * @example Handling events by tag
 * ```ts
 * yield* durableObjectAlarm.processDueAlarms((event) =>
 *   event.tag === "heartbeat"
 *     ? heartbeatManager.handleAlarmEvent(event).pipe(Effect.asVoid)
 *     : Effect.void
 * );
 * ```
 */
export const DurableObjectAlarmEvent = S.TaggedUnion({
  AlarmDue: {
    id: S.NonEmptyString,
    payload: S.Json,
    scheduledAt: S.DateTimeUtc,
    tag: S.NonEmptyString,
  },
});
export type DurableObjectAlarmEvent = typeof DurableObjectAlarmEvent.Type;

/**
 * Stable reference for a scheduled alarm.
 *
 * The pair of `tag` and `id` is the durable identity. Scheduling another alarm
 * with the same pair replaces the previous alarm, and cancellation uses the
 * same pair.
 *
 * @example Cancel an alarm
 * ```ts
 * yield* durableObjectAlarm.cancelAlarm({
 *   tag: "connection-reconnect-grace",
 *   id: "reconnect-grace-check",
 * });
 * ```
 */
export type AlarmRef<Tag extends string = string> = {
  readonly id: string;
  readonly tag: Tag;
};

const AlarmRefSchema = S.Struct({
  id: S.NonEmptyString,
  tag: S.NonEmptyString,
});

const decodeAlarmRef = (input: AlarmRef) =>
  S.decodeUnknownEffect(AlarmRefSchema)(input).pipe(
    Effect.mapError((cause) => new InvalidAlarmRefError({ cause })),
  );

/**
 * Input for scheduling or replacing an alarm.
 *
 * `runAt` is the absolute first fire time. `repeatEvery` can be any Effect
 * `Duration.Input`, including strings like `"5 seconds"`, numbers interpreted
 * as milliseconds, or `Duration` values.
 *
 * @example One-shot alarm
 * ```ts
 * const now = yield* DateTime.now;
 *
 * yield* durableObjectAlarm.scheduleAlarm({
 *   tag: "connection-reconnect-grace",
 *   id: "reconnect-grace-check",
 *   runAt: DateTime.add(now, { seconds: 15 }),
 *   payload: { reason: "socket-closed" },
 * });
 * ```
 *
 * @example Repeating alarm
 * ```ts
 * const now = yield* DateTime.now;
 *
 * yield* durableObjectAlarm.scheduleAlarm({
 *   tag: "heartbeat",
 *   id: "heartbeat-check",
 *   runAt: DateTime.add(now, { seconds: 5 }),
 *   repeatEvery: "5 seconds",
 *   payload: null,
 * });
 * ```
 */
export type ScheduleAlarmInput<Tag extends string = string> = AlarmRef<Tag> & {
  readonly payload: AlarmPayload;
  readonly repeatEvery?: Duration.Input;
  readonly runAt: DateTime.Utc;
};

export type ProcessDueAlarmsMode = "isolated" | "ordered";

export interface ProcessDueAlarmsFailure {
  readonly cause: unknown;
  readonly event?: DurableObjectAlarmEvent;
  readonly id: string;
  readonly storageId: string;
  readonly tag: string;
}

export interface ProcessDueAlarmsResult {
  readonly failed: readonly ProcessDueAlarmsFailure[];
  readonly handled: readonly DurableObjectAlarmEvent[];
}

export type ProcessDueAlarmsFailureAction =
  | "ordered"
  | "retry"
  | "skip-and-advance-repeat"
  | {
      readonly mode: "ordered";
    }
  | {
      readonly mode: "retry";
      readonly retryFailedAfter?: Duration.Input;
    }
  | {
      readonly mode: "skip-and-advance-repeat";
    };

export interface ProcessDueAlarmsOptions<OnFailureR = never, OnFailureE = never> {
  /** Maximum due rows to load and process in one invocation. Defaults to 100. */
  readonly limit?: number;
  /**
   * Failure isolation mode. Defaults to `isolated` so one poison logical alarm
   * does not block unrelated maintenance work.
   */
  readonly mode?: ProcessDueAlarmsMode;
  /**
   * Callback for logical handler/decode failures. Return a failure action to
   * override the global failure behavior for this row.
   */
  readonly onFailure?: (
    failure: ProcessDueAlarmsFailure,
  ) => Effect.Effect<ProcessDueAlarmsFailureAction | void, OnFailureE, OnFailureR>;
  /**
   * Delay before retrying a failed logical row in isolated mode. Defaults to 30
   * seconds. Ignored by ordered mode unless supplied explicitly.
   *
   * Retrying updates only the selected occurrence, so replacements scheduled by
   * a long-running handler are not clobbered by failure handling.
   */
  readonly retryFailedAfter?: Duration.Input;
}

/**
 * Handler invoked for each due alarm before that alarm is acknowledged.
 *
 * If the handler fails, `DurableObjectAlarm` leaves the row due and fails the alarm
 * processing effect. Cloudflare can then retry the Durable Object alarm handler,
 * and the scheduler will find the same logical row again because `run_at` is
 * still less than or equal to the retry time.
 */
export type ProcessDueAlarmsHandler<R = never, E = never> = (
  event: DurableObjectAlarmEvent,
) => Effect.Effect<void, E, R>;

/**
 * Durable alarm scheduler API.
 *
 * This service only owns scheduling semantics. It does not publish, subscribe,
 * or dispatch events to consumers. Durable Object alarm handlers should pass a
 * domain handler to `processDueAlarms`; rows are acknowledged only after that
 * handler succeeds.
 *
 * This service must be the only code path that owns `storage.setAlarm()` inside
 * a Durable Object instance. Cloudflare exposes one platform alarm timestamp per
 * object, so another scheduler in the same object can clobber this service's
 * reconciled alarm timestamp.
 *
 * @example Durable Object alarm handler
 * ```ts
 * const onAlarm = Effect.gen(function* () {
 *   const durableObjectAlarm = yield* DurableObjectAlarm;
 *
 *   yield* durableObjectAlarm.processDueAlarms((event) =>
 *     Effect.gen(function* () {
 *       if (event.tag === "heartbeat") {
 *         yield* heartbeatManager.handleAlarmEvent(event);
 *         return;
 *       }
 *
 *       if (event.tag === "connection-reconnect-grace") {
 *         yield* connectionManager.expireReconnectGracePeriods();
 *       }
 *     })
 *   );
 * });
 * ```
 */
export type AlarmScheduler = {
  /**
   * Cancel a scheduled alarm by `{ tag, id }`.
   *
   * This is idempotent. Cancelling a missing alarm is a no-op. The underlying
   * Durable Object alarm is reconciled afterward.
   */
  readonly cancelAlarm: (
    input: AlarmRef,
  ) => Effect.Effect<void, InvalidAlarmRefError | StorageOperationError>;

  /**
   * Process due alarms according to `Clock.currentTimeMillis`.
   *
   * Each row is acknowledged only after `handle` succeeds. One-shot alarms are
   * then deleted. Repeating alarms are rescheduled to `acknowledgedAt +
   * repeatEvery`, which intentionally behaves as delay-after-success rather
   * than fixed-cadence catch-up. Acknowledgements are conditional on the stored
   * row still matching the selected occurrence, so a handler that reschedules
   * the same `{ tag, id }` will not have its replacement clobbered by the old
   * acknowledgement.
   *
   * Processing is ordered by `runAt` and stable alarm id. By default, logical
   * handler/decode failures are isolated to the failing row: the row is retried
   * after `retryFailedAfter`, later due rows still run, and the result reports
   * both handled and failed rows. Use `mode: "ordered"` when a workflow
   * intentionally requires strict head-of-line blocking.
   *
   * Handlers must still be idempotent: Cloudflare alarms are at-least-once, and
   * if a handler succeeds but the acknowledgement write fails, the logical event
   * can be delivered again.
   */
  readonly processDueAlarms: <R = never, E = never, OnFailureR = never, OnFailureE = never>(
    handle: ProcessDueAlarmsHandler<R, E>,
    options?: ProcessDueAlarmsOptions<OnFailureR, OnFailureE>,
  ) => Effect.Effect<
    ProcessDueAlarmsResult,
    E | OnFailureE | DurableObjectAlarmError,
    R | OnFailureR
  >;

  /**
   * Schedule or replace an alarm by `{ tag, id }`.
   *
   * The durable row write and underlying platform alarm reconciliation are run
   * in one Durable Object storage transaction, so a failed `setAlarm` rolls back
   * the logical schedule instead of leaving a stored-but-unarmed alarm.
   */
  readonly scheduleAlarm: (
    input: ScheduleAlarmInput,
  ) => Effect.Effect<
    void,
    | InvalidAlarmPayloadError
    | InvalidAlarmRefError
    | InvalidRepeatEveryError
    | StorageOperationError
  >;
};

const StoredPayloadString = S.fromJsonString(S.Json);

const decodeStoredPayload = (row: AlarmRow) =>
  S.decodeUnknownEffect(StoredPayloadString)(row.payload).pipe(
    Effect.mapError((cause) => new StoredAlarmDecodeError({ cause, storageId: row.storage_id })),
  );

const encodeStoredPayload = (payload: AlarmPayload) =>
  S.encodeEffect(StoredPayloadString)(payload).pipe(
    Effect.mapError((cause) => new InvalidAlarmPayloadError({ cause })),
  );

const ensureTable = (state: DurableObjectState["Service"]) =>
  state.storage.sql.exec(INIT_TABLE_SQL).pipe(Effect.asVoid);

const toRepeatEveryMillis = (input: Duration.Input | undefined) => {
  if (input === undefined) {
    return Effect.succeed(null);
  }

  return Effect.try({
    try: () => {
      const millis = Duration.toMillis(Duration.fromInputUnsafe(input));
      if (!Number.isFinite(millis) || millis <= 0) {
        throw new Error("Alarm repeatEvery must be a positive finite duration");
      }

      return Math.ceil(millis);
    },
    catch: (cause) => new InvalidRepeatEveryError({ cause }),
  });
};

const toAlarmDue = (row: AlarmRow) =>
  Effect.gen(function* () {
    if (!Number.isFinite(row.run_at)) {
      return yield* Effect.fail(
        new StoredAlarmDecodeError({
          cause: new Error("Stored alarm run_at must be a finite number"),
          storageId: row.storage_id,
        }),
      );
    }

    return DurableObjectAlarmEvent.make({
      _tag: "AlarmDue",
      id: row.alarm_id,
      payload: yield* decodeStoredPayload(row),
      scheduledAt: DateTime.toUtc(DateTime.makeUnsafe(row.run_at)),
      tag: row.tag,
    });
  });

const getProcessLimit = (options: ProcessDueAlarmsOptions<unknown, unknown> | undefined) => {
  const limit = options?.limit ?? DEFAULT_PROCESS_DUE_ALARMS_LIMIT;

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return Effect.fail(
      new InvalidProcessDueAlarmsOptionsError({
        cause: new Error("processDueAlarms limit must be a positive safe integer"),
      }),
    );
  }

  return Effect.succeed(limit);
};

const toFailureRescheduleMillis = (input: Duration.Input) =>
  Effect.try({
    try: () => {
      const millis = Duration.toMillis(Duration.fromInputUnsafe(input));
      if (!Number.isFinite(millis) || millis <= 0) {
        throw new Error("Alarm failure rescheduleAfter must be a positive finite duration");
      }

      return Math.ceil(millis);
    },
    catch: (cause) => new InvalidProcessDueAlarmsOptionsError({ cause }),
  });

const getFailureRetryDelay = (options: ProcessDueAlarmsOptions<unknown, unknown> | undefined) =>
  toFailureRescheduleMillis(
    options?.retryFailedAfter ?? DEFAULT_PROCESS_DUE_ALARMS_FAILURE_RESCHEDULE_AFTER,
  );

const getFailureActionMode = (action: ProcessDueAlarmsFailureAction) =>
  typeof action === "string" ? action : action.mode;

const getFailureActionRetryDelay = (action: ProcessDueAlarmsFailureAction) =>
  typeof action === "string" || action.mode !== "retry" ? undefined : action.retryFailedAfter;

export const processDue = <R = never, E = never, OnFailureR = never, OnFailureE = never>(
  handle: ProcessDueAlarmsHandler<R, E>,
  options: ProcessDueAlarmsOptions<OnFailureR, OnFailureE> = {},
) =>
  Effect.gen(function* () {
    const durableObjectAlarm = yield* DurableObjectAlarm;
    return yield* durableObjectAlarm.processDueAlarms(handle, options);
  });

export const process = processDue;

export type AlarmPayloadSchema = S.Codec<any, any, never, never>;

export type AlarmFailurePolicy = "ordered" | "retry" | "skip-and-advance-repeat";

export interface AlarmRetryPolicy {
  readonly initialDelay?: Duration.Input;
}

export interface AlarmDefinitionConfig<Payload extends AlarmPayloadSchema = AlarmPayloadSchema> {
  readonly failure?: AlarmFailurePolicy;
  readonly payload: Payload;
  readonly retry?: AlarmRetryPolicy;
}

export type AlarmDefinitionEntry = AlarmDefinitionConfig | AlarmPayloadSchema;

export type AlarmDefinitions = Readonly<Record<string, AlarmDefinitionEntry>>;

type AlarmDefinitionSchema<Definition> =
  Definition extends AlarmDefinitionConfig<infer Payload> ? Payload : Definition;

export type AlarmDefinitionPayload<Definition> =
  AlarmDefinitionSchema<Definition> extends S.Codec<infer A, any, never, never> ? A : never;

export type DefinedAlarmEvent<Tag extends string, Payload> = Omit<
  DurableObjectAlarmEvent,
  "payload" | "tag"
> & {
  readonly payload: Payload;
  readonly tag: Tag;
};

export type DefinedAlarmHandlers<Definitions extends AlarmDefinitions, R = never, E = never> = {
  readonly [Tag in keyof Definitions & string]: (
    event: DefinedAlarmEvent<Tag, AlarmDefinitionPayload<Definitions[Tag]>>,
  ) => Effect.Effect<void, E, R>;
};

const isAlarmDefinitionConfig = (
  definition: AlarmDefinitionEntry,
): definition is AlarmDefinitionConfig =>
  typeof definition === "object" && definition !== null && "payload" in definition;

const getAlarmDefinitionSchema = (definition: AlarmDefinitionEntry) =>
  isAlarmDefinitionConfig(definition) ? definition.payload : definition;

const getAlarmDefinitionFailureAction = (
  definition: AlarmDefinitionEntry | undefined,
): ProcessDueAlarmsFailureAction | undefined => {
  if (definition === undefined || !isAlarmDefinitionConfig(definition)) {
    return undefined;
  }

  if (definition.failure === undefined) {
    return undefined;
  }

  return definition.failure === "retry"
    ? { mode: "retry", retryFailedAfter: definition.retry?.initialDelay }
    : { mode: definition.failure };
};

export const define = <const Definitions extends AlarmDefinitions>(definitions: Definitions) => ({
  handlers: <R = never, E = never>(
    handlers: DefinedAlarmHandlers<Definitions, R, E>,
    options?: ProcessDueAlarmsOptions<R, E>,
  ) =>
    processDue(
      (event) =>
        Effect.gen(function* () {
          const definition = definitions[event.tag];
          if (definition === undefined) {
            return;
          }

          const schema = getAlarmDefinitionSchema(definition);
          const payload = yield* (
            S.decodeUnknownEffect(schema)(event.payload) as Effect.Effect<
              AlarmDefinitionPayload<Definitions[keyof Definitions & string]>,
              unknown
            >
          ).pipe(
            Effect.mapError(
              (cause) =>
                new StoredAlarmDecodeError({
                  cause,
                  storageId: getScheduledEventId(event),
                }),
            ),
          );
          const handler = handlers[event.tag];

          yield* handler({ ...event, payload } as never);
        }),
      {
        ...options,
        onFailure: (failure) =>
          Effect.gen(function* () {
            const action = getAlarmDefinitionFailureAction(definitions[failure.tag]);
            const optionAction =
              options?.onFailure === undefined ? undefined : yield* options.onFailure(failure);
            return action ?? optionAction;
          }),
      },
    ),
});

/**
 * SQLite-backed Durable Object alarm scheduler.
 *
 * `DurableObjectAlarm` stores alarms in the current Durable Object's SQLite storage
 * and keeps the platform alarm set to the earliest pending scheduled alarm. The
 * platform alarm timestamp is only a wake-up hint; logical event identity comes
 * from persisted `{ tag, id }` rows.
 *
 * Retry safety depends on acknowledgement ordering. `processDueAlarms` runs the
 * caller's handler first and only then conditionally deletes or advances the
 * same selected row. By default, handler failures are isolated: the failed row
 * is retried after a delay, later due rows continue, and the platform alarm is
 * reconciled once at the end. Use `mode: "ordered"` for strict workflows where
 * one failed logical alarm should block later due alarms.
 *
 * Provide `DurableObjectAlarm.layer` anywhere `DurableObjectState` is available.
 *
 * @example Providing the service
 * ```ts
 * const program = Effect.gen(function* () {
 *   const durableObjectAlarm = yield* DurableObjectAlarm;
 *   const now = yield* DateTime.now;
 *
 *   yield* durableObjectAlarm.scheduleAlarm({
 *     tag: "heartbeat",
 *     id: "heartbeat-check",
 *     runAt: DateTime.add(now, { seconds: 5 }),
 *     repeatEvery: Duration.seconds(5),
 *     payload: null,
 *   });
 * }).pipe(Effect.provide(DurableObjectAlarm.layer));
 * ```
 *
 * @example Processing due alarms
 * ```ts
 * const handledEvents = yield* durableObjectAlarm.processDueAlarms((event) =>
 *   Effect.gen(function* () {
 *     if (event.tag === "heartbeat") {
 *       yield* heartbeatManager.handleAlarmEvent(event);
 *     }
 *   })
 * );
 * ```
 */
export class DurableObjectAlarm extends Context.Service<DurableObjectAlarm, AlarmScheduler>()(
  "effect-cf/DurableObjectAlarm",
) {
  static readonly layer = Layer.effect(
    DurableObjectAlarm,
    Effect.gen(function* () {
      const state = yield* DurableObjectState;

      const reconcileAlarm = Effect.fn("DurableObjectAlarm.reconcileAlarm")(function* () {
        const cursor = yield* state.storage.sql.exec<NextAlarmRow>(
          `SELECT run_at FROM effect_cf_scheduled_alarms ORDER BY run_at ASC, storage_id ASC LIMIT 1`,
        );
        const next = (yield* cursor.toArray())[0];

        if (next === undefined) {
          yield* state.storage.deleteAlarm();
          return;
        }

        yield* state.storage.setAlarm(next.run_at);
      });

      const rescheduleFailedAlarm = Effect.fn("DurableObjectAlarm.rescheduleFailedAlarm")(
        function* (row: AlarmRow, retryDelayMillis: number) {
          const retryAt = (yield* Clock.currentTimeMillis) + retryDelayMillis;

          if (row.repeat_every_ms === null) {
            const cursor = yield* state.storage.sql.exec(
              `UPDATE effect_cf_scheduled_alarms
                  SET run_at = ?
                WHERE storage_id = ?
                  AND run_at = ?
                  AND repeat_every_ms IS NULL
                  AND payload = ?`,
              retryAt,
              row.storage_id,
              row.run_at,
              row.payload,
            );
            yield* cursor.rowsWritten;
            return;
          }

          const cursor = yield* state.storage.sql.exec(
            `UPDATE effect_cf_scheduled_alarms
                SET run_at = ?
              WHERE storage_id = ?
                AND run_at = ?
                AND repeat_every_ms = ?
                AND payload = ?`,
            retryAt,
            row.storage_id,
            row.run_at,
            row.repeat_every_ms,
            row.payload,
          );
          yield* cursor.rowsWritten;
        },
      );

      const acknowledgeAlarm = Effect.fn("DurableObjectAlarm.acknowledgeAlarm")(function* (
        row: AlarmRow,
      ) {
        if (row.repeat_every_ms === null) {
          const cursor = yield* state.storage.sql.exec(
            `DELETE FROM effect_cf_scheduled_alarms
              WHERE storage_id = ?
                AND run_at = ?
                AND repeat_every_ms IS NULL
                AND payload = ?`,
            row.storage_id,
            row.run_at,
            row.payload,
          );
          yield* cursor.rowsWritten;
          return;
        }

        const acknowledgedAt = yield* Clock.currentTimeMillis;
        const cursor = yield* state.storage.sql.exec(
          `UPDATE effect_cf_scheduled_alarms
              SET run_at = ?
            WHERE storage_id = ?
              AND run_at = ?
              AND repeat_every_ms = ?
              AND payload = ?`,
          acknowledgedAt + row.repeat_every_ms,
          row.storage_id,
          row.run_at,
          row.repeat_every_ms,
          row.payload,
        );
        yield* cursor.rowsWritten;
      });

      const cancelAlarm = Effect.fn("DurableObjectAlarm.cancelAlarm")(function* (input: AlarmRef) {
        const ref = yield* decodeAlarmRef(input);
        yield* state.storage.transaction(() =>
          Effect.gen(function* () {
            yield* ensureTable(state);
            yield* state.storage.sql
              .exec(
                `DELETE FROM effect_cf_scheduled_alarms WHERE storage_id = ?`,
                getScheduledEventId(ref),
              )
              .pipe(Effect.asVoid);
            yield* reconcileAlarm();
          }),
        );
      });

      const scheduleAlarm = Effect.fn("DurableObjectAlarm.scheduleAlarm")(function* (
        input: ScheduleAlarmInput,
      ) {
        const ref = yield* decodeAlarmRef(input);
        const repeatEveryMillis = yield* toRepeatEveryMillis(input.repeatEvery);
        const payload = yield* encodeStoredPayload(input.payload);
        const runAt = DateTime.toEpochMillis(input.runAt);

        yield* state.storage.transaction(() =>
          Effect.gen(function* () {
            yield* ensureTable(state);
            yield* state.storage.sql
              .exec(
                `INSERT OR REPLACE INTO effect_cf_scheduled_alarms
                   (storage_id, alarm_id, tag, run_at, repeat_every_ms, payload)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                getScheduledEventId(ref),
                ref.id,
                ref.tag,
                runAt,
                repeatEveryMillis,
                payload,
              )
              .pipe(Effect.asVoid);
            yield* reconcileAlarm();
          }),
        );
      });

      const processDueAlarms = Effect.fn("DurableObjectAlarm.processDueAlarms")(function* <
        R,
        E,
        OnFailureR,
        OnFailureE,
      >(
        handle: ProcessDueAlarmsHandler<R, E>,
        options?: ProcessDueAlarmsOptions<OnFailureR, OnFailureE>,
      ) {
        yield* ensureTable(state);
        const mode = options?.mode ?? "isolated";
        const limit = yield* getProcessLimit(options);
        const now = yield* Clock.currentTimeMillis;
        const cursor = yield* state.storage.sql.exec<AlarmRow>(
          `SELECT storage_id, alarm_id, tag, run_at, repeat_every_ms, payload
             FROM effect_cf_scheduled_alarms
            WHERE run_at <= ?
            ORDER BY run_at ASC, storage_id ASC
            LIMIT ?`,
          now,
          limit,
        );
        const dueRows = yield* cursor.toArray();
        const handled: DurableObjectAlarmEvent[] = [];
        const failed: ProcessDueAlarmsFailure[] = [];

        const handleFailure = function* (
          row: AlarmRow,
          event: DurableObjectAlarmEvent | undefined,
          cause: unknown,
        ) {
          const failure: ProcessDueAlarmsFailure = {
            cause,
            event,
            id: row.alarm_id,
            storageId: row.storage_id,
            tag: row.tag,
          };

          failed.push(failure);
          const failureAction =
            options?.onFailure === undefined ? undefined : yield* options.onFailure(failure);
          const actionMode =
            failureAction === undefined ? mode : getFailureActionMode(failureAction);

          if (actionMode === "retry" || actionMode === "isolated") {
            const actionRetryDelay =
              failureAction === undefined ? undefined : getFailureActionRetryDelay(failureAction);
            const retryDelay =
              actionRetryDelay === undefined
                ? yield* getFailureRetryDelay(options)
                : yield* toFailureRescheduleMillis(actionRetryDelay);

            yield* rescheduleFailedAlarm(row, retryDelay);
            return "continue" as const;
          }

          if (actionMode === "skip-and-advance-repeat") {
            yield* acknowledgeAlarm(row);
            return "continue" as const;
          }

          yield* reconcileAlarm();
          return "stop" as const;
        };

        for (const row of dueRows) {
          const eventExit = yield* Effect.exit(toAlarmDue(row));

          if (Exit.isFailure(eventExit)) {
            const action = yield* handleFailure(row, undefined, eventExit.cause);
            if (action === "stop") {
              return yield* Effect.failCause(eventExit.cause);
            }
            continue;
          }

          const event = eventExit.value;
          const handleExit = yield* Effect.exit(handle(event));

          if (Exit.isFailure(handleExit)) {
            const action = yield* handleFailure(row, event, handleExit.cause);
            if (action === "stop") {
              return yield* Effect.failCause(handleExit.cause);
            }
            continue;
          }

          yield* acknowledgeAlarm(row);
          handled.push(event);
        }

        yield* reconcileAlarm();
        return { failed, handled };
      });

      return DurableObjectAlarm.of({
        cancelAlarm,
        processDueAlarms,
        scheduleAlarm,
      });
    }).pipe(Effect.withSpan("DurableObjectAlarm.layer")),
  );
}
