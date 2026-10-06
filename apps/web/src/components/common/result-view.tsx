import type React from "react"
import { cn } from "@maple/ui/lib/utils"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { Result } from "@/lib/effect-atom"
import { ErrorState } from "./error-state"

interface ResultViewProps<A, E> {
	readonly result: Result.Result<A, E>
	/** Rendered before the first value arrives. */
	readonly loading: React.ReactNode
	/** Replaces the default `ErrorState`; receives the squashed error. */
	readonly error?: (error: E) => React.ReactNode
	readonly errorTitle?: string
	readonly onRetry?: () => void
	readonly errorVariant?: "panel" | "row" | "inline"
	/** With `empty`, renders it instead of the children when the value has nothing to show. */
	readonly isEmpty?: (value: A) => boolean
	readonly empty?: React.ReactNode
	/** Wraps the success view in a div that dims while a refetch is in flight. */
	readonly dimWhileWaiting?: boolean
	readonly className?: string
	readonly children: (value: A, state: { readonly waiting: boolean }) => React.ReactNode
}

/** The loading / error / empty / success switch every data view writes around a `Result`. */
export function ResultView<A, E>({
	result,
	loading,
	error,
	errorTitle,
	onRetry,
	errorVariant,
	isEmpty,
	empty,
	dimWhileWaiting = false,
	className,
	children,
}: ResultViewProps<A, E>): React.ReactNode {
	return Result.builder(result)
		.onSuccess((value, success) => {
			if (empty !== undefined && isEmpty?.(value)) return empty
			const view = children(value, { waiting: success.waiting })
			if (!dimWhileWaiting) return view
			return (
				<div
					className={cn(className, refreshingClass(success.waiting))}
					aria-busy={success.waiting || undefined}
				>
					{view}
				</div>
			)
		})
		.onError((cause) =>
			error ? (
				error(cause)
			) : (
				<ErrorState error={cause} title={errorTitle} onRetry={onRetry} variant={errorVariant} />
			),
		)
		.orElse(() => loading)
}
