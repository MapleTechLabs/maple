import { Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { Block } from "foldkit"
import * as Dom from "foldkit/dom"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"

// Port of packages/ui/src/components/ui/tabs.tsx (Base UI Tabs, horizontal, manual activation):
// arrow keys and Home/End move the focused tab (Base UI's highlight), click/Enter/Space select it.
// The indicator rect is measured like Base UI's `TabsIndicator` and written as CSS variables.

export const ActivationDirection = Schema.Literals(["none", "left", "right"])
export type ActivationDirection = typeof ActivationDirection.Type

export const IndicatorRect = Schema.Struct({
	left: Schema.Number,
	right: Schema.Number,
	top: Schema.Number,
	bottom: Schema.Number,
	width: Schema.Number,
	height: Schema.Number,
})
export type IndicatorRect = typeof IndicatorRect.Type

// MODEL

export const Model = Schema.Struct({
	/** The id seed of this Tabs, so element ids follow Base UI's format (`base-ui-_r_<n>_`). */
	idBase: Schema.Number,
	values: Schema.Array(Schema.String),
	selected: Schema.String,
	highlightedIndex: Schema.Number,
	activationDirection: ActivationDirection,
	maybeIndicator: Schema.Option(IndicatorRect),
})
export type Model = typeof Model.Type

export interface InitConfig {
	readonly idBase: number
	readonly values: ReadonlyArray<string>
	readonly selected: string
}

const initialModel = (config: InitConfig): Model => ({
	idBase: config.idBase,
	values: config.values,
	selected: config.selected,
	highlightedIndex: Math.max(0, config.values.indexOf(config.selected)),
	activationDirection: "none",
	maybeIndicator: Option.none(),
})

export const tabId = (model: Model, index: number): string => `base-ui-_r_${model.idBase + index}_`
export const panelId = (model: Model): string => `base-ui-_r_${model.idBase + model.values.length}_`

// MESSAGE

export const TabKey = Schema.Literals(["ArrowLeft", "ArrowRight", "Home", "End"])
export type TabKey = typeof TabKey.Type

export const Message = defineMessageUnion({
	ClickedTab: { index: Schema.Number },
	PressedTabKey: { key: TabKey },
	MeasuredIndicator: { rect: IndicatorRect },
	CompletedFocusTab: {},
	/** Operation: start over on `selected`, as a fresh `init` with the same ids and values. */
	RequestedReset: { selected: Schema.String },
	/** Operation: the parent selected `value` (a route change); the highlight follows it. */
	RequestedSelect: { value: Schema.String },
	/** Operation: the parent selected `value`; the highlight stays where it is. */
	InformedOfSelection: { value: Schema.String },
})
export type Message = typeof Message.Type

// OUT MESSAGE

/** A tab click moved the selection; reported only when the selected value changes. */
export const OutMessage = defineMessageUnion({
	ChangedSelection: { value: Schema.String, index: Schema.Number },
})
export type OutMessage = typeof OutMessage.Type

export const TabsDefinition = Block.makeDefinition("Tabs", { Model, Message, OutMessage })

// COMMAND

export const FocusTab = TabsDefinition.makeCommand("FocusTab", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusTab],
	handler: function* () {
		return ({ id }) =>
			Dom.focus(`[id="${id}"]`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusTab()))
	},
})

// UPDATE

const wrap = (index: number, count: number): number => ((index % count) + count) % count

const nextHighlight = (model: Model, key: TabKey): number => {
	const count = model.values.length
	switch (key) {
		case "ArrowLeft":
			return wrap(model.highlightedIndex - 1, count)
		case "ArrowRight":
			return wrap(model.highlightedIndex + 1, count)
		case "Home":
			return 0
		case "End":
			return count - 1
	}
}

const isSameRect = (a: IndicatorRect, b: IndicatorRect): boolean =>
	a.left === b.left &&
	a.right === b.right &&
	a.top === b.top &&
	a.bottom === b.bottom &&
	a.width === b.width &&
	a.height === b.height

// MOUNT

/** Base UI's `getCssDimensions`: the computed size unless it disagrees with the offset size. */
const cssDimensions = (element: HTMLElement): { width: number; height: number } => {
	const css = getComputedStyle(element)
	const width = Number.parseFloat(css.width) || 0
	const height = Number.parseFloat(css.height) || 0
	const fallback = Math.round(width) !== element.offsetWidth || Math.round(height) !== element.offsetHeight
	return fallback ? { width: element.offsetWidth, height: element.offsetHeight } : { width, height }
}

/** `TabsIndicator`'s rect for the selected tab of `list` (tabs are untransformed list children). */
const measureIndicator = (list: HTMLElement): IndicatorRect | undefined => {
	const tab = list.querySelector<HTMLElement>(':scope > [role="tab"][aria-selected="true"]')
	if (tab === null) return undefined
	const { width, height } = cssDimensions(tab)
	const tabRect = tab.getBoundingClientRect()
	const listRect = list.getBoundingClientRect()
	const listSize = cssDimensions(list)
	const scaleX = listSize.width > 0 ? listRect.width / listSize.width : 1
	const scaleY = listSize.height > 0 ? listRect.height / listSize.height : 1
	const rectLeft = (tabRect.left - listRect.left) / scaleX + list.scrollLeft - list.clientLeft
	const rectTop = (tabRect.top - listRect.top) / scaleY + list.scrollTop - list.clientTop
	const isNear = Math.abs(rectLeft - tab.offsetLeft) <= 2 && Math.abs(rectTop - tab.offsetTop) <= 2
	const left = isNear ? rectLeft : tab.offsetLeft
	const top = isNear ? rectTop : tab.offsetTop
	return {
		left,
		top,
		width,
		height,
		right: list.scrollWidth - left - width,
		bottom: list.scrollHeight - top - height,
	}
}

type MeasuredIndicator = typeof Message.MeasuredIndicator.Type

const observeIndicator = (list: HTMLElement): Stream.Stream<MeasuredIndicator> =>
	Stream.callback<MeasuredIndicator>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const emit = () => {
					const rect = measureIndicator(list)
					if (rect !== undefined) Queue.offerUnsafe(queue, Message.MeasuredIndicator({ rect }))
				}
				const resizes = new ResizeObserver(emit)
				resizes.observe(list)
				list.querySelectorAll(':scope > [role="tab"]').forEach((tab) => resizes.observe(tab))
				const selection = new MutationObserver(emit)
				selection.observe(list, {
					subtree: true,
					attributes: true,
					attributeFilter: ["aria-selected", "style", "hidden"],
				})
				emit()
				return () => {
					resizes.disconnect()
					selection.disconnect()
				}
			}),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

/** On the tab list: reports the indicator rect on mount, on resize and when the selection moves. */
export const MeasureTabIndicator = TabsDefinition.makeMountStream("MeasureTabIndicator", {
	messages: [Message.MeasuredIndicator],
	handler: function* () {
		return ({ element, viewStateChanges }) =>
			viewStateChanges.pipe(
				Stream.switchMap((viewState) =>
					viewState === "Live" && element instanceof HTMLElement
						? observeIndicator(element)
						: Stream.never,
				),
			)
	},
})

/** The handlers this Block owns; pass to `prepareBlock`. */
export const EffectsLayer = Layer.mergeAll(FocusTab.layer, MeasureTabIndicator.layer)

// COMPOSITION

export const TabsComposition = TabsDefinition.makeComposition({ mounts: [MeasureTabIndicator] })
export type TabsViewBuilder = Block.ViewBuilderFor<typeof TabsComposition>

// INIT

export const init = TabsComposition.makeInit((config: InitConfig) => ({ model: initialModel(config) }))

// UPDATE

const { makeStep } = TabsDefinition

const clickTabStep = makeStep((model, index: number) => {
	const value = model.values[index]
	if (value === undefined) return { model }
	const previous = model.values.indexOf(model.selected)
	if (value === model.selected) return { model: modifyFields(model, { highlightedIndex: () => index }) }
	return {
		model: modifyFields(model, {
			selected: () => value,
			highlightedIndex: () => index,
			activationDirection: (): ActivationDirection => (index > previous ? "right" : "left"),
		}),
		outMessage: OutMessage.ChangedSelection({ value, index }),
	}
})

export const update = TabsComposition.makeUpdate({
	ClickedTab: (model, { index }) => clickTabStep(model, index),
	PressedTabKey: (model, { key }) => {
		const highlightedIndex = nextHighlight(model, key)
		return {
			model: modifyFields(model, { highlightedIndex: () => highlightedIndex }),
			commands: [FocusTab({ id: tabId(model, highlightedIndex) })],
		}
	},
	MeasuredIndicator: (model, { rect }) =>
		Option.exists(model.maybeIndicator, (current) => isSameRect(current, rect))
			? { model }
			: { model: modifyFields(model, { maybeIndicator: () => Option.some(rect) }) },
	CompletedFocusTab: (model) => ({ model }),
	RequestedReset: (model, { selected }) => ({
		model: initialModel({ idBase: model.idBase, values: model.values, selected }),
	}),
	RequestedSelect: (model, { value }) => ({
		model: modifyFields(model, {
			selected: () => value,
			highlightedIndex: () => model.values.indexOf(value),
		}),
	}),
	InformedOfSelection: (model, { value }) => ({ model: modifyFields(model, { selected: () => value }) }),
})
