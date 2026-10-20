import {
	DEFAULT_FUNNEL_KEY_BY,
	DEFAULT_FUNNEL_WINDOW_SECONDS,
	FUNNEL_SESSION_DIMENSIONS,
} from "../../../components/funnels/definition"
import type { EditorState, FunnelDraft, ListColumn, PathsDraft, StepDraft } from "./editor-state"
import { DEFAULT_LIST_COLUMNS } from "./lowering-list"
import { ProductEdit, type StepKind, type StepScope, type StepTextField } from "./product-edit"

// What each `ProductEdit` does to the editor state: `ListConfigPanel`'s `onChange`, the
// `FunnelStepBuilder`'s `onChange`, and `updateFunnel` / `updatePaths`.

/** `withKind`: a step's kind changed, carrying nothing over. */
const withKind = (step: StepDraft, kind: StepKind): StepDraft => {
	if (step.kind === kind) return step
	switch (kind) {
		case "event":
			return { kind: "event", eventName: "" }
		case "page":
			return { kind: "page", pagePath: "" }
		case "session":
			return { kind: "session", dimension: "referrerHost", value: "" }
	}
}

/** `move`: an item moved within the list; out of range is a no-op. */
const move = <T>(items: ReadonlyArray<T>, from: number, to: number): ReadonlyArray<T> => {
	const item = items[from]
	if (to < 0 || to >= items.length || item === undefined) return items
	const rest = items.filter((_, index) => index !== from)
	return [...rest.slice(0, to), item, ...rest.slice(to)]
}

/** A typed field of a step; an emptied host or filter drops its key. */
const withText = (step: StepDraft, field: StepTextField, value: string): StepDraft => {
	switch (step.kind) {
		case "event": {
			if (field === "eventName") return { ...step, eventName: value }
			if (field !== "filterClause") return step
			const { filterClause: _clause, ...rest } = step
			return value === "" ? rest : { ...rest, filterClause: value }
		}
		case "page": {
			if (field === "pagePath") return { ...step, pagePath: value }
			if (field !== "host") return step
			const { host: _host, ...rest } = step
			return value === "" ? rest : { ...rest, host: value }
		}
		case "session":
			return field === "value" ? { ...step, value } : step
	}
}

const updateAt = <T>(items: ReadonlyArray<T>, index: number, update: (item: T) => T): ReadonlyArray<T> =>
	items.map((item, position) => (position === index ? update(item) : item))

const editSteps = (
	state: EditorState,
	scope: StepScope,
	index: number,
	update: (step: StepDraft) => StepDraft,
): EditorState =>
	scope === "funnel"
		? { ...state, funnel: { ...state.funnel, steps: updateAt(state.funnel.steps, index, update) } }
		: // The anchor is never a session step: the panel offers none, and `onChange` drops one.
			((anchor) =>
				anchor.kind === "session" ? state : { ...state, paths: { ...state.paths, anchor } })(
				update(state.paths.anchor),
			)

const funnel = (state: EditorState, update: (funnel: FunnelDraft) => FunnelDraft): EditorState => ({
	...state,
	funnel: update(state.funnel),
})
const paths = (state: EditorState, update: (paths: PathsDraft) => PathsDraft): EditorState => ({
	...state,
	paths: update(state.paths),
})
const columns = (
	state: EditorState,
	update: (columns: ReadonlyArray<ListColumn>) => ReadonlyArray<ListColumn>,
) => ({
	...state,
	listColumns: update(state.listColumns),
})

/** An add-on turned off puts its value back to the default, so the bar reads as "what is set". */
const toggleFunnelAddOn = (current: FunnelDraft, key: keyof FunnelDraft["addOns"]): FunnelDraft => {
	const isOn = !current.addOns[key]
	const addOns = { ...current.addOns, [key]: isOn }
	if (isOn) return { ...current, addOns }
	switch (key) {
		case "keyBy":
			return { ...current, addOns, keyBy: DEFAULT_FUNNEL_KEY_BY }
		case "window":
			return { ...current, addOns, windowSeconds: DEFAULT_FUNNEL_WINDOW_SECONDS }
		case "breakdown": {
			const { breakdownBy: _breakdownBy, ...rest } = current
			return { ...rest, addOns }
		}
	}
}

const togglePathsAddOn = (current: PathsDraft, key: keyof PathsDraft["addOns"]): PathsDraft => {
	const isOn = !current.addOns[key]
	const addOns = { ...current.addOns, [key]: isOn }
	if (isOn) return { ...current, addOns }
	switch (key) {
		case "keyBy":
			return { ...current, addOns, keyBy: "person" }
		case "window":
			return { ...current, addOns, windowSeconds: 24 * 3600 }
		case "include":
			return { ...current, addOns, include: "all" }
		case "exclude":
			return { ...current, addOns, excludeText: "" }
	}
}

/** `BreakdownPicker`'s `onChange`: none, a session dimension, or a non-empty `attribute:<key>`. */
const withBreakdown = (current: FunnelDraft, value: string | null): FunnelDraft => {
	const { breakdownBy: _previous, ...rest } = current
	if (value === null) return rest
	if (value.startsWith("attribute:") && value.length > "attribute:".length)
		return { ...rest, breakdownBy: `attribute:${value.slice("attribute:".length)}` }
	const dimension = FUNNEL_SESSION_DIMENSIONS.find((candidate) => candidate === value)
	return dimension === undefined ? rest : { ...rest, breakdownBy: dimension }
}

/** A funnel step moved; a session step past step 1 is demoted to an event step (`reorder`). */
const reorderSteps = (steps: ReadonlyArray<StepDraft>, from: number, to: number): ReadonlyArray<StepDraft> =>
	move(steps, from, to).map((step, index) =>
		index > 0 && step.kind === "session" ? withKind(step, "event") : step,
	)

export const applyProductEdit = (state: EditorState, edit: ProductEdit): EditorState =>
	ProductEdit.match<EditorState>(edit, {
		// A new source starts over: its default columns, no filter.
		SetListSource: ({ source }) => ({
			...state,
			listDataSource: source,
			listWhereClause: "",
			listColumns: DEFAULT_LIST_COLUMNS[source].map((column) => ({ ...column })),
		}),
		ToggledListRootOnly: () => ({ ...state, listRootOnly: !state.listRootOnly }),
		ChangedListWhere: ({ value }) => ({ ...state, listWhereClause: value }),
		ChangedListLimit: ({ value }) => ({ ...state, listLimit: value }),
		ChangedListColumnText: ({ index, field, value }) =>
			columns(state, (list) => updateAt(list, index, (column) => ({ ...column, [field]: value }))),
		PickedListField: ({ index, field }) =>
			columns(state, (list) =>
				updateAt(list, index, (column) => ({
					...column,
					field,
					header: field.split(".").pop() ?? field,
				})),
			),
		SetListColumnUnit: ({ index, unit }) =>
			columns(state, (list) =>
				updateAt(list, index, (column) => {
					const { unit: _unit, ...rest } = column
					return unit === "none" ? rest : { ...rest, unit }
				}),
			),
		SetListColumnAlign: ({ index, align }) =>
			columns(state, (list) => updateAt(list, index, (column) => ({ ...column, align }))),
		RemovedListColumn: ({ index }) =>
			columns(state, (list) => list.filter((_, position) => position !== index)),
		AddedListColumn: () => columns(state, (list) => [...list, { field: "", header: "" }]),
		MovedListColumn: ({ index, delta }) =>
			columns(state, (list) =>
				move(list, index, Math.max(0, Math.min(list.length - 1, index + delta))),
			),
		SetStepKind: ({ scope, index, kind }) =>
			editSteps(state, scope, index, (step) => withKind(step, kind)),
		ChangedStepText: ({ scope, index, field, value }) =>
			editSteps(state, scope, index, (step) => withText(step, field, value)),
		SetStepDimension: ({ scope, index, dimension }) =>
			editSteps(state, scope, index, (step) =>
				step.kind === "session" ? { ...step, dimension } : step,
			),
		MovedStep: ({ index, delta }) =>
			funnel(state, (current) => ({
				...current,
				steps: reorderSteps(current.steps, index, index + delta),
			})),
		RemovedStep: ({ index }) =>
			funnel(state, (current) => ({
				...current,
				steps: current.steps.filter((_, position) => position !== index),
			})),
		AddedStep: () =>
			funnel(state, (current) => ({
				...current,
				steps: [...current.steps, { kind: "event", eventName: "" }],
			})),
		ChangedPopulationFilter: ({ scope, value }) =>
			scope === "funnel"
				? funnel(state, (current) => ({ ...current, filterClause: value }))
				: paths(state, (current) => ({ ...current, filterClause: value })),
		ToggledFunnelAddOn: ({ key }) => funnel(state, (current) => toggleFunnelAddOn(current, key)),
		ToggledPathsAddOn: ({ key }) => paths(state, (current) => togglePathsAddOn(current, key)),
		SetKeyBy: ({ scope, keyBy }) =>
			scope === "funnel"
				? funnel(state, (current) => ({ ...current, keyBy }))
				: paths(state, (current) => ({ ...current, keyBy })),
		SetWindow: ({ scope, seconds }) =>
			!Number.isFinite(seconds) || seconds <= 0
				? state
				: scope === "funnel"
					? funnel(state, (current) => ({ ...current, windowSeconds: seconds }))
					: paths(state, (current) => ({ ...current, windowSeconds: seconds })),
		SetBreakdown: ({ value }) => funnel(state, (current) => withBreakdown(current, value)),
		SetFunnelVariant: ({ variant }) => funnel(state, (current) => ({ ...current, variant })),
		SetFunnelStepPercent: ({ value }) =>
			funnel(state, (current) => ({
				...current,
				showStepPercent: value === "auto" ? null : value === "conversion",
			})),
		SetPathsDirection: ({ direction }) => paths(state, (current) => ({ ...current, direction })),
		SetPathsDepth: ({ depth }) => paths(state, (current) => ({ ...current, depth })),
		SetPathsBranches: ({ branches }) => paths(state, (current) => ({ ...current, branches })),
		SetPathsInclude: ({ include }) => paths(state, (current) => ({ ...current, include })),
		ChangedPathsExclude: ({ value }) => paths(state, (current) => ({ ...current, excludeText: value })),
	})
