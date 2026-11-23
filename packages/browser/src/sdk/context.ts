// Synchronous context for the browser, which has no async context: `with` sets
// the active context for the call and restores the previous one after it.
import { type Context, type ContextManager, ROOT_CONTEXT } from "@opentelemetry/api"

export class StackContextManager implements ContextManager {
	private current: Context = ROOT_CONTEXT
	private enabled = false

	active(): Context {
		return this.current
	}

	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		context: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		const previous = this.current
		// A caller passing no context (plain JS) gets the root one, as with the OTel SDK.
		this.current = context ?? ROOT_CONTEXT
		try {
			return fn.apply(thisArg, args)
		} finally {
			this.current = previous
		}
	}

	bind<T>(context: Context | undefined, target: T): T {
		if (typeof target !== "function") return target
		const bound = context ?? this.active()
		const withBound = (run: () => void): void => this.with(bound, run)
		// A transparent forwarder: whatever `target` takes and returns passes through untouched.
		// oxlint-disable-next-line anti-slop/no-unknown-returns
		const wrapper = function (this: unknown, ...args: unknown[]): unknown {
			let result: unknown
			withBound(() => {
				result = target.apply(this, args)
			})
			return result
		}
		Object.defineProperty(wrapper, "length", {
			enumerable: false,
			configurable: true,
			writable: false,
			value: target.length,
		})
		return wrapper as T
	}

	enable(): this {
		if (this.enabled) return this
		this.enabled = true
		this.current = ROOT_CONTEXT
		return this
	}

	disable(): this {
		this.current = ROOT_CONTEXT
		this.enabled = false
		return this
	}
}
