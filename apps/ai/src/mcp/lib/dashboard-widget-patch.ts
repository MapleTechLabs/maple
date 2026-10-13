// BOUNDARY: a merge patch is untyped JSON until the merged widget is decoded again.
/** Partial widget edits: a JSON Merge Patch (RFC 7386) plus shorthand fields, over the saved widget. */
import { Result, Schema, SchemaIssue } from "effect"
import { DashboardWidgetSchema } from "@maple/domain/http"
import type { DashboardWidget } from "./dashboard-mutations"

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** Objects merge key by key, `null` deletes a key, anything else (arrays included) replaces. */
export const mergePatch = (target: unknown, patch: unknown): unknown => {
	if (!isPlainObject(patch)) return patch
	const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {}
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete result[key]
		else result[key] = mergePatch(result[key], value)
	}
	return result
}

export interface WidgetPatch {
	readonly patch?: unknown
	readonly title?: string
	readonly chartId?: string
}

export const hasWidgetPatch = (patch: WidgetPatch): boolean =>
	patch.patch !== undefined || patch.title !== undefined || patch.chartId !== undefined

const encodeWidget = Schema.encodeUnknownResult(DashboardWidgetSchema)
const decodeWidget = Schema.decodeUnknownResult(DashboardWidgetSchema)
const formatIssue = SchemaIssue.makeFormatterDefault()

/** The saved widget with the patch applied, decoded again; `Failure` carries a readable reason. */
export const patchWidget = (
	existing: DashboardWidget,
	patch: WidgetPatch,
): Result.Result<DashboardWidget, string> => {
	const encoded = encodeWidget(existing)
	if (Result.isFailure(encoded)) return Result.fail(formatIssue(encoded.failure.issue))
	const shorthand = {
		display: {
			...(patch.title === undefined ? undefined : { title: patch.title }),
			...(patch.chartId === undefined ? undefined : { chartId: patch.chartId }),
		},
	}
	const merged = mergePatch(mergePatch(encoded.success, patch.patch ?? {}), shorthand)
	const withId = isPlainObject(merged) ? { ...merged, id: existing.id } : merged
	const decoded = decodeWidget(withId)
	return Result.isFailure(decoded)
		? Result.fail(`The patched widget is not valid:\n${formatIssue(decoded.failure.issue)}`)
		: Result.succeed(decoded.success)
}
