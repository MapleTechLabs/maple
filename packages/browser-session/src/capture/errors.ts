import { activeTraceId } from "../events/trace-id"
import { truncateText } from "../platform/text"
import { type Emit, safeEmit } from "./shared"

const MAX_STACK = 4_000
const MAX_MESSAGE = 1_000

/** Capture uncaught errors + unhandled promise rejections as session events. */
export function installErrorCapture(emit: Emit): () => void {
	const onError = (event: ErrorEvent): void => {
		safeEmit(emit, {
			type: "error",
			level: "error",
			message: truncate(event.message || String(event.error ?? "Error"), MAX_MESSAGE),
			errorStack: truncate(describeRejection(event.error).stack, MAX_STACK),
			traceId: activeTraceId(),
		})
	}

	const onRejection = (event: PromiseRejectionEvent): void => {
		const { message, stack } = describeRejection(event.reason)
		safeEmit(emit, {
			type: "error",
			level: "error",
			message: truncate(message, MAX_MESSAGE),
			errorStack: truncate(stack, MAX_STACK),
			traceId: activeTraceId(),
		})
	}

	window.addEventListener("error", onError)
	window.addEventListener("unhandledrejection", onRejection)

	return () => {
		window.removeEventListener("error", onError)
		window.removeEventListener("unhandledrejection", onRejection)
	}
}

/** An error or rejection reason is anything a `throw` or `reject()` was given. */
function describeRejection(reason: unknown): { message: string; stack: string | undefined } {
	if (typeof reason === "string") return { message: reason, stack: undefined }
	if (typeof reason !== "object" || reason === null) {
		return { message: "Unhandled promise rejection", stack: undefined }
	}
	const message = "message" in reason && typeof reason.message === "string" ? reason.message : undefined
	return {
		message: message ?? "Unhandled promise rejection",
		stack: "stack" in reason && typeof reason.stack === "string" ? reason.stack : undefined,
	}
}

/** Cut on a code-point boundary: half an emoji is a lone surrogate, which ingest rejects with its batch. */
function truncate(text: string | undefined, max: number): string | undefined {
	if (!text) return undefined
	return truncateText(text, max, "…")
}
