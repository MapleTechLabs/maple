import type { Row } from "@electric-sql/client"
import type {
	DeleteMutationFnParams,
	InsertMutationFnParams,
	UpdateMutationFnParams,
	UtilsRecord,
} from "@tanstack/db"
import type { Txid } from "@tanstack/electric-db-collection"
import { Cause, Effect, Exit, type ManagedRuntime, Option, Array as Arr } from "effect"
import { DeleteError, InsertError, MissingTxIdError, UpdateError } from "./errors"
import type { EffectDeleteHandler, EffectInsertHandler, EffectUpdateHandler } from "./types"

type PromiseMutationHandler<Params> = (params: Params) => Promise<void>

// Electric deprecated returning `{ txid }`; awaiting it here is what it did with the return value.
const awaitTxids = (utils: UtilsRecord, txid: Txid | Array<Txid>) =>
	Promise.all(Arr.map(Arr.isArray(txid) ? txid : [txid], (id) => utils.awaitTxId(id)))

/** Adapts an Effect insert handler to Electric's Promise API. */
export function convertInsertHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
>(
	handler: EffectInsertHandler<T, TKey, TUtils, E> | undefined,
	runtime?: undefined,
): PromiseMutationHandler<InsertMutationFnParams<T, TKey, TUtils>> | undefined
export function convertInsertHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectInsertHandler<T, TKey, TUtils, E, R> | undefined,
	runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
): PromiseMutationHandler<InsertMutationFnParams<T, TKey, TUtils>> | undefined
export function convertInsertHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectInsertHandler<T, TKey, TUtils, E, R> | undefined,
	runtime?: ManagedRuntime.ManagedRuntime<R, unknown>,
): PromiseMutationHandler<InsertMutationFnParams<T, TKey, TUtils>> | undefined {
	if (!handler) return undefined

	return async (params: InsertMutationFnParams<T, TKey, TUtils>) => {
		const effect = handler(params).pipe(
			Effect.catchEager((error: E) =>
				Effect.fail(
					new InsertError({
						message: `Insert operation failed`,
						data: params.transaction.mutations[0]?.modified,
						cause: error,
					}),
				),
			),
		)

		const exit = runtime
			? await runtime.runPromiseExit(effect)
			: await Effect.runPromiseExit(
					// The overload without a runtime only accepts handlers whose requirements are `never`.
					// oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion
					effect as Effect.Effect<{ txid: Txid | Array<Txid> }, InsertError>,
				)

		if (Exit.isFailure(exit)) {
			const cause = exit.cause
			const failReason = Arr.findFirst(cause.reasons, Cause.isFailReason)
			if (Option.isSome(failReason)) {
				throw failReason.value.error
			}
			throw new InsertError({
				message: `Insert operation failed unexpectedly`,
				data: params.transaction.mutations[0]?.modified,
				cause: cause,
			})
		}

		const result = exit.value

		if (result.txid == null || result.txid === 0) {
			throw new MissingTxIdError({
				message: `Insert handler must return a txid`,
				operation: "insert",
			})
		}

		await awaitTxids(params.collection.utils, result.txid)
	}
}

/** Adapts an Effect update handler to Electric's Promise API. */
export function convertUpdateHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
>(
	handler: EffectUpdateHandler<T, TKey, TUtils, E> | undefined,
	runtime?: undefined,
): PromiseMutationHandler<UpdateMutationFnParams<T, TKey, TUtils>> | undefined
export function convertUpdateHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectUpdateHandler<T, TKey, TUtils, E, R> | undefined,
	runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
): PromiseMutationHandler<UpdateMutationFnParams<T, TKey, TUtils>> | undefined
export function convertUpdateHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectUpdateHandler<T, TKey, TUtils, E, R> | undefined,
	runtime?: ManagedRuntime.ManagedRuntime<R, unknown>,
): PromiseMutationHandler<UpdateMutationFnParams<T, TKey, TUtils>> | undefined {
	if (!handler) return undefined

	return async (params: UpdateMutationFnParams<T, TKey, TUtils>) => {
		const effect = handler(params).pipe(
			Effect.catchEager((error: E) =>
				Effect.fail(
					new UpdateError({
						message: `Update operation failed`,
						key: params.transaction.mutations[0]?.key,
						cause: error,
					}),
				),
			),
		)

		const exit = runtime
			? await runtime.runPromiseExit(effect)
			: await Effect.runPromiseExit(
					// The overload without a runtime only accepts handlers whose requirements are `never`.
					// oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion
					effect as Effect.Effect<{ txid: Txid | Array<Txid> }, UpdateError>,
				)

		if (Exit.isFailure(exit)) {
			const cause = exit.cause
			const failReason = Arr.findFirst(cause.reasons, Cause.isFailReason)
			if (Option.isSome(failReason)) {
				throw failReason.value.error
			}
			throw new UpdateError({
				message: `Update operation failed unexpectedly`,
				key: params.transaction.mutations[0]?.key,
				cause: cause,
			})
		}

		const result = exit.value

		if (result.txid == null || result.txid === 0) {
			throw new MissingTxIdError({
				message: `Update handler must return a txid`,
				operation: "update",
			})
		}

		await awaitTxids(params.collection.utils, result.txid)
	}
}

/** Adapts an Effect delete handler to Electric's Promise API. */
export function convertDeleteHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
>(
	handler: EffectDeleteHandler<T, TKey, TUtils, E> | undefined,
	runtime?: undefined,
): PromiseMutationHandler<DeleteMutationFnParams<T, TKey, TUtils>> | undefined
export function convertDeleteHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectDeleteHandler<T, TKey, TUtils, E, R> | undefined,
	runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
): PromiseMutationHandler<DeleteMutationFnParams<T, TKey, TUtils>> | undefined
export function convertDeleteHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectDeleteHandler<T, TKey, TUtils, E, R> | undefined,
	runtime?: ManagedRuntime.ManagedRuntime<R, unknown>,
): PromiseMutationHandler<DeleteMutationFnParams<T, TKey, TUtils>> | undefined {
	if (!handler) return undefined

	return async (params: DeleteMutationFnParams<T, TKey, TUtils>) => {
		const effect = handler(params).pipe(
			Effect.catchEager((error: E) =>
				Effect.fail(
					new DeleteError({
						message: `Delete operation failed`,
						key: params.transaction.mutations[0]?.key,
						cause: error,
					}),
				),
			),
		)

		const exit = runtime
			? await runtime.runPromiseExit(effect)
			: await Effect.runPromiseExit(
					// The overload without a runtime only accepts handlers whose requirements are `never`.
					// oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion
					effect as Effect.Effect<{ txid: Txid | Array<Txid> }, DeleteError>,
				)

		if (Exit.isFailure(exit)) {
			const cause = exit.cause
			const failReason = Arr.findFirst(cause.reasons, Cause.isFailReason)
			if (Option.isSome(failReason)) {
				throw failReason.value.error
			}
			throw new DeleteError({
				message: `Delete operation failed unexpectedly`,
				key: params.transaction.mutations[0]?.key,
				cause: cause,
			})
		}

		const result = exit.value

		if (result.txid == null || result.txid === 0) {
			throw new MissingTxIdError({
				message: `Delete handler must return a txid`,
				operation: "delete",
			})
		}

		await awaitTxids(params.collection.utils, result.txid)
	}
}
