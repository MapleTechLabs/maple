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
		return actionRef.current(...args).finally(() => setPending(false))
	}, [])
	return [run, pending] as const
}

interface MutationActionOptions<A> {
	/** Success toast title; a function receives the mutation's value. Omit for no success toast. */
	readonly success?: string | ((value: A) => string)
	/** Failure toast title; the description is the error's user-facing message. */
	readonly error: string
	/** Runs after a success toast, before `run` resolves (close a dialog, reset a form). */
	readonly onSuccess?: (value: A) => void
}

/**
 * A `promiseExit` mutation atom with its pending flag and outcome toasts. `run` resolves to the
 * Exit, so a caller can still branch on it: `if (Exit.isSuccess(await run(payload))) close()`.
 */
export function useMutationAction<A, E, W>(
	atom: Atom.Writable<AsyncResult.AsyncResult<A, E>, W>,
	options: MutationActionOptions<A>,
): readonly [run: (value: W) => Promise<Exit.Exit<A, E>>, pending: boolean] {
	const mutate = useAtomSet(atom, { mode: "promiseExit" })
	const optionsRef = useRef(options)
	optionsRef.current = options
	return useAsyncAction((value: W) =>
		mutate(value).then((exit) => {
			const { success, error, onSuccess } = optionsRef.current
			if (!Exit.isSuccess(exit)) {
				toastExit(exit, { error })
				return exit
			}
			toastExit(exit, { error, success: typeof success === "function" ? success(exit.value) : success })
			onSuccess?.(exit.value)
			return exit
		}),
	)
}
