import { httpStatusTone } from "@maple/ui/lib/http"
import { spanStartMs } from "@maple/ui/lib/span-tree"
import type { SpanNode } from "@maple/ui/lib/types"

/** The span's HTTP response status, read off the attribute: `getHttpInfo` gives up on names with no method. */
export function spanHttpStatus(span: SpanNode): number | undefined {
	const raw =
		span.spanAttributes?.["http.response.status_code"] || span.spanAttributes?.["http.status_code"]
	const code = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
	return Number.isNaN(code) ? undefined : code
}

/** A span failed when its status says so or it answered with a 5xx. */
export function isErrorSpan(span: SpanNode): boolean {
	if (span.isMissing) return false
	if (span.statusCode === "Error") return true
	return httpStatusTone(spanHttpStatus(span)) === "crit"
}

export interface TraceErrors {
	/** Every failed span, earliest first. */
	readonly spans: ReadonlyArray<SpanNode>
	/**
	 * Where the failure most likely started: the earliest failed span with no failed
	 * descendant. Errors propagate up the tree, so the innermost one is the cause.
	 */
	readonly origin: SpanNode | undefined
}

export function collectTraceErrors(rootSpans: ReadonlyArray<SpanNode>): TraceErrors {
	const spans: Array<SpanNode> = []
	const origins: Array<SpanNode> = []

	// Returns whether the subtree holds a failed span.
	const visit = (span: SpanNode): boolean => {
		const descendantFailed = span.children.map(visit).some(Boolean)
		const failed = isErrorSpan(span)
		if (failed) {
			spans.push(span)
			if (!descendantFailed) origins.push(span)
		}
		return failed || descendantFailed
	}
	for (const root of rootSpans) visit(root)

	const byStart = (a: SpanNode, b: SpanNode) => spanStartMs(a) - spanStartMs(b)
	return { spans: spans.sort(byStart), origin: origins.sort(byStart)[0] }
}
