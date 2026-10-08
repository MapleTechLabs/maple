import { isClerkAPIResponseError, isReverificationCancelledError } from "@clerk/clerk-react/errors"
import { toastManager } from "@maple/ui/components/ui/toast"

/**
 * Clerk's instance-level toggles — authenticator app, backup codes, passkeys, self-serve
 * deletion — are not readable from the client (only through the internal
 * `clerk.__unstable__environment`), so an account section cannot pre-gate itself on them.
 * Surfacing Clerk's own message is what turns "something went wrong" into "authenticator app
 * is disabled for this instance".
 */
export function accountErrorMessage(err: unknown, fallback: string): string {
	if (isClerkAPIResponseError(err)) {
		const first = err.errors[0]
		return first?.longMessage ?? first?.message ?? fallback
	}
	return err instanceof Error ? err.message : fallback
}

/** Toast a failed Clerk call. Dismissing the reverification challenge is a no-op, not an error. */
export function toastAccountError(err: unknown, fallback: string) {
	if (isReverificationCancelledError(err)) return
	toastManager.add({ title: accountErrorMessage(err, fallback), type: "error" })
}

/**
 * Settles a Clerk call into a boolean: toasts `success` (when given) or Clerk's own failure
 * message, so call sites never wrap Clerk promises in try/catch.
 */
export function settleClerk(
	promise: Promise<unknown>,
	options: { readonly success?: string; readonly error: string },
): Promise<boolean> {
	return promise.then(
		() => {
			if (options.success !== undefined) toastManager.add({ title: options.success, type: "success" })
			return true
		},
		(err: unknown) => {
			toastAccountError(err, options.error)
			return false
		},
	)
}
