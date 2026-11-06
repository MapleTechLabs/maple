import type { CloudflareWorkerSummary } from "@maple/domain/cloud-platform"
import { Array as Arr, String as Str } from "effect"

// The trace views' rendering of a Workers summary. Kept free of React imports so the Foldkit
// dashboard and the React adapter show the same rows from the same detector.

export interface CloudflareDisplayField {
	readonly label: string
	readonly value: string
	readonly display?: string
	readonly copyable?: boolean
	readonly wide?: boolean
}

export interface CloudflareDisplay {
	readonly edge: string | null
	readonly location: string | null
	readonly outcome: { readonly value: string; readonly bad: boolean } | null
	readonly fields: ReadonlyArray<CloudflareDisplayField>
}

const join = (separator: string, ...parts: ReadonlyArray<string | undefined>): string | null =>
	Arr.join(
		Arr.filter(parts, (part) => part !== undefined),
		separator,
	) || null

export const cloudflareDisplay = (worker: CloudflareWorkerSummary): CloudflareDisplay => {
	const { scriptName, scriptVersion, executionModel, handler, cpuTimeMs, wallTimeMs, ttfbMs, rayId } =
		worker
	const fields: ReadonlyArray<CloudflareDisplayField | null> = [
		scriptName === undefined ? null : { label: "Script", value: scriptName },
		scriptVersion === undefined
			? null
			: {
					label: "Version",
					value: scriptVersion,
					display: Str.slice(0, 8)(scriptVersion),
					copyable: true,
				},
		executionModel === undefined ? null : { label: "Model", value: executionModel },
		handler === undefined ? null : { label: "Handler", value: handler },
		cpuTimeMs === undefined
			? null
			: {
					label: "CPU / Wall",
					value: wallTimeMs === undefined ? `${cpuTimeMs}ms` : `${cpuTimeMs}ms / ${wallTimeMs}ms`,
				},
		ttfbMs === undefined ? null : { label: "TTFB", value: `${ttfbMs}ms` },
		rayId === undefined ? null : { label: "Ray ID", value: rayId, copyable: true, wide: true },
	]
	return {
		edge: join(" · ", worker.colo, worker.region),
		location: join(", ", worker.city, worker.countryCode),
		outcome:
			worker.outcome === undefined
				? null
				: { value: worker.outcome, bad: Str.toLowerCase(worker.outcome) !== "ok" },
		fields: Arr.filter(fields, (field): field is CloudflareDisplayField => field !== null),
	}
}
