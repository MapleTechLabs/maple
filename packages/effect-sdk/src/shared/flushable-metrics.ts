import { Context, Layer, Metric } from "effect"

export interface MetricBuffer {
	readonly layer: Layer.Layer<never>
	readonly drain: () => Array<Metric.Metric.Snapshot>
	readonly restore: (items: ReadonlyArray<Metric.Metric.Snapshot>) => void
	readonly setDisabled: (value: boolean) => void
}

/**
 * Consent over the cumulative registry. Revoking after capture is terminal for
 * the page: cumulative state cannot forget prior samples, and clearing the
 * registry breaks cached Metric hooks. A late first grant still works.
 */
type MetricsState =
	| { readonly _tag: "Uncaptured"; readonly disabled: boolean }
	| { readonly _tag: "Capturing"; readonly dirty: boolean }
	| { readonly _tag: "Revoked"; readonly disabled: boolean }

/**
 * Isolated cumulative registry. Drains only after changes, and `restore`
 * re-marks failed exports as pending.
 */
export const makeMetricBuffer = (): MetricBuffer => {
	let state: MetricsState = { _tag: "Uncaptured", disabled: false }
	const isDisabled = (): boolean => state._tag !== "Capturing" && state.disabled
	const onUpdate = (): void => {
		if (state._tag !== "Revoked") state = { _tag: "Capturing", dirty: true }
	}
	// oxlint-disable-next-line typescript/no-explicit-any -- Effect's metric registry holds every metric type
	const registry = new Map<string, Metric.Metric.Metadata<any, any>>()
	// Gate hooks so pre-consent updates never enter cumulative state.
	const set = registry.set.bind(registry)
	registry.set = (key, metadata) => {
		const hooks = metadata.hooks
		// oxlint-disable-next-line typescript/no-explicit-any -- Effect's metric registry holds every metric type
		;(metadata as { hooks: Metric.Metric.Hooks<any, any> }).hooks = {
			get: hooks.get,
			update: (input, context) => {
				if (isDisabled()) return
				hooks.update(input, context)
				onUpdate()
			},
			modify: (input, context) => {
				if (isDisabled()) return
				hooks.modify(input, context)
				onUpdate()
			},
		}
		return set(key, metadata)
	}
	const snapshotContext = Context.make(Metric.MetricRegistry, registry)
	return {
		layer: Layer.succeed(Metric.MetricRegistry, registry),
		drain: () => {
			if (state._tag !== "Capturing" || !state.dirty) return []
			state = { _tag: "Capturing", dirty: false }
			return [...Metric.snapshotUnsafe(snapshotContext)]
		},
		restore: (items) => {
			if (items.length > 0 && state._tag === "Capturing") state = { _tag: "Capturing", dirty: true }
		},
		setDisabled: (value) => {
			if (state._tag === "Capturing") {
				if (value) state = { _tag: "Revoked", disabled: true }
			} else state = { ...state, disabled: value }
		},
	}
}
