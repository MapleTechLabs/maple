import { useCallback, useRef, useState } from "react"
import { Exit } from "effect"
import type * as AsyncResult from "effect/reactivity/AsyncResult"
import type * as Atom from "effect/reactivity/Atom"
import { useAtomSet } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"

/**
 * Tracks whether an async action is in flight. `run` resolves to the action's own result; the
 * pending flag clears however it settles. The shape every hand-rolled `setBusy(true)/false` had.
 */
export function useAsyncAction<Args extends ReadonlyArray<unknown>, R>(
	action: (...args: Args) => Promise<R>,
): readonly [run: (...args: Args) => Promise<R>, pending: boolean] {
	const [pending, setPending] = useState(false)
	const actionRef = useRef(action)
	actionRef.current = action
	const run = useCallback((...args: Args): Promise<R> => {
		setPending(true)
		// The executor turns a synchronous throw into a rejection, so the flag always clears.
		return new Promise<R>((resolve) => resolve(actionRef.current(...args))).finally(() =>
			setPending(false),
		)
	}, [])
	return [run, pending] as const
}

export interface KeyedAction<K extends string, Args extends ReadonlyArray<unknown>, R> {
	readonly run: (key: K, ...args: Args) => Promise<R>
	readonly isPending: (key: K) => boolean
	/** True while any key is in flight. */
	readonly anyPending: boolean
}

/**
 * `useAsyncAction` for per-row actions: each call carries a key (a row id), and `isPending(key)`
 * reports only that row, so one row's spinner does not disable the whole list.
 */
export function useKeyedAsyncAction<K extends string, Args extends ReadonlyArray<unknown>, R>(
	action: (key: K, ...args: Args) => Promise<R>,
): KeyedAction<K, Args, R> {
	const [pendingKeys, setPendingKeys] = useState<ReadonlySet<K>>(() => new Set())
	const actionRef = useRef(action)
	actionRef.current = action
	const run = useCallback((key: K, ...args: Args): Promise<R> => {
		setPendingKeys((prev) => new Set(prev).add(key))
		return new Promise<R>((resolve) => resolve(actionRef.current(key, ...args))).finally(() =>
			setPendingKeys((prev) => {
				const next = new Set(prev)
				next.delete(key)
				return next
			}),
		)
	}, [])
	const isPending = useCallback((key: K) => pendingKeys.has(key), [pendingKeys])
	return { run, isPending, anyPending: pendingKeys.size > 0 }
}

interface MutationActionOptions<A> {
	/** Success toast title; a function receives the mutation's value. Omit for no success toast. */
	readonly success?: string | ((value: A) => string)
	/** Failure toast title; the description is the error's user-facing message. */
	readonly error: string
	/** Runs after a success toast, before `run` resolves (close a dialog, reset a form). */
	readonly onSuccess?: (value: A) => void
}

function useMutationRunner<A, E, W>(
	atom: Atom.Writable<AsyncResult.AsyncResult<A, E>, W>,
	options: MutationActionOptions<A>,
): (value: W) => Promise<Exit.Exit<A, E>> {
	const mutate = useAtomSet(atom, { mode: "promiseExit" })
	const optionsRef = useRef(options)
	optionsRef.current = options
	return (value: W) =>
		mutate(value).then((exit) => {
			const { success, error, onSuccess } = optionsRef.current
			if (!Exit.isSuccess(exit)) {
				toastExit(exit, { error })
				return exit
			}
			toastExit(exit, { error, success: typeof success === "function" ? success(exit.value) : success })
			onSuccess?.(exit.value)
			return exit
		})
}

/**
 * A `promiseExit` mutation atom with its pending flag and outcome toasts. `run` resolves to the
 * Exit, so a caller can still branch on it: `if (Exit.isSuccess(await run(payload))) close()`.
 */
export function useMutationAction<A, E, W>(
	atom: Atom.Writable<AsyncResult.AsyncResult<A, E>, W>,
	options: MutationActionOptions<A>,
): readonly [run: (value: W) => Promise<Exit.Exit<A, E>>, pending: boolean] {
	return useAsyncAction(useMutationRunner(atom, options))
}
