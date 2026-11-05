import {
	DEFAULT_FUNNEL_KEY_BY,
	DEFAULT_FUNNEL_WINDOW_SECONDS,
	FUNNEL_SESSION_DIMENSIONS,
} from "../../../components/funnels/definition"
import { FUNNEL_MAX_STEPS } from "@maple/query-model"
import { applyAnchorEdit, applyStepEdit, type StepEdit, type StepScope } from "../../kit/funnel-steps"
import type { EditorState, FunnelDraft, ListColumn, PathsDraft } from "./editor-state"
import { DEFAULT_LIST_COLUMNS } from "./lowering-list"
import { ProductEdit } from "./product-edit"
import { Array as Arr, String as Str } from "effect"

// What each `ProductEdit` does to the editor state: `ListConfigPanel`'s `onChange`, the
// `FunnelStepBuilder`'s `onChange`, and `updateFunnel` / `updatePaths`.

/** `move`: an item moved within the list; out of range is a no-op. */
const move = <T>(items: ReadonlyArray<T>, from: number, to: number): ReadonlyArray<T> => {
	const item = items[from]
	if (to < 0 || to >= items.length || item === undefined) return items
	const rest = Arr.filter(items, (_, index) => index !== from)
	return [...rest.slice(0, to), item, ...rest.slice(to)]
}

const updateAt = <T>(items: ReadonlyArray<T>, index: number, update: (item: T) => T): ReadonlyArray<T> =>
	Arr.map(items, (item, position) => (position === index ? update(item) : item))

/** A step builder edit on the funnel's steps, or on the paths anchor (never a session step). */
const editSteps = (state: EditorState, scope: StepScope, edit: StepEdit): EditorState => {
	if (scope === "funnel")
		return {
			...state,
			funnel: { ...state.funnel, steps: applyStepEdit(state.funnel.steps, edit, FUNNEL_MAX_STEPS) },
		}
	return { ...state, paths: { ...state.paths, anchor: applyAnchorEdit(state.paths.anchor, edit) } }
}

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
	if (Str.startsWith("attribute:")(value) && value.length > "attribute:".length)
		return { ...rest, breakdownBy: `attribute:${Str.slice("attribute:".length)(value)}` }
	const dimension = FUNNEL_SESSION_DIMENSIONS.find((candidate) => candidate === value)
	return dimension === undefined ? rest : { ...rest, breakdownBy: dimension }
}

export const applyProductEdit = (state: EditorState, edit: ProductEdit): EditorState =>
	ProductEdit.match<EditorState>(edit, {
		// A new source starts over: its default columns, no filter.
		SetListSource: ({ source }) => ({
			...state,
			listDataSource: source,
			listWhereClause: "",
			listColumns: Arr.map(DEFAULT_LIST_COLUMNS[source], (column) => ({ ...column })),
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
					header: Str.split(".")(field).pop() ?? field,
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
			columns(state, (list) => Arr.filter(list, (_, position) => position !== index)),
		AddedListColumn: () => columns(state, (list) => [...list, { field: "", header: "" }]),
		MovedListColumn: ({ index, delta }) =>
			columns(state, (list) =>
				move(list, index, Math.max(0, Math.min(list.length - 1, index + delta))),
			),
		Step: ({ scope, edit }) => editSteps(state, scope, edit),
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
