import { Array as Arr, Option } from "effect"

// Where a component sits: groups listed where their first member is, members in page order, and
// a move only ever within the row's group. The builder and Settings > Monitors share it.

/** A row with a place on the page: a saved component, or a row in the builder. */
export type Groupable = { readonly id: string; readonly group: string | null }

/**
 * The components as the public page lists them: each group, ungrouped ones too, where its first
 * member is, then its members in page order.
 */
export const groupedOrder = <A extends Groupable>(components: ReadonlyArray<A>): ReadonlyArray<A> =>
	Arr.flatMap(Arr.dedupe(Arr.map(components, (component) => component.group)), (group) =>
		Arr.filter(components, (component) => component.group === group),
	)

/** A component's place among its group's members; `null` when it is not listed. */
export const groupIndexOf = <A extends Groupable>(
	components: ReadonlyArray<A>,
	componentId: string,
): number | null =>
	Option.getOrNull(
		Option.map(
			Arr.findFirst(components, (component) => component.id === componentId),
			(item) => Arr.filter(components, (component) => component.group === item.group).indexOf(item),
		),
	)

/**
 * The list with `componentId` at `index` among its group's members (clamped to the group), the
 * members between shifting a slot; other groups keep their places. `null` when it is not listed
 * or already there.
 */
export const moved = <A extends Groupable>(
	components: ReadonlyArray<A>,
	componentId: string,
	index: number,
): ReadonlyArray<A> | null => {
	const item = Arr.findFirst(components, (component) => component.id === componentId)
	if (Option.isNone(item)) return null
	const group = Arr.filter(components, (component) => component.group === item.value.group)
	const to = Math.min(Math.max(index, 0), group.length - 1)
	if (to === group.indexOf(item.value)) return null
	const rest = Arr.filter(group, (component) => component.id !== componentId)
	const order = [...Arr.take(rest, to), item.value, ...Arr.drop(rest, to)]
	// The group's slots in page order, filled with its new order.
	return Arr.mapAccum(components, 0, (rank, component): [number, A] =>
		component.group === item.value.group ? [rank + 1, order[rank] ?? component] : [rank, component],
	)[1]
}

/** The groups in page order, `null` for the ungrouped components. */
export const groupOrder = <A extends Groupable>(components: ReadonlyArray<A>): ReadonlyArray<string | null> =>
	Arr.dedupe(Arr.map(components, (component) => component.group))

/**
 * The list with `group`'s members moved, together, to the `index`th place among the groups (clamped);
 * every group keeps its members' order. `null` when the group is not listed or already there.
 */
export const movedGroup = <A extends Groupable>(
	components: ReadonlyArray<A>,
	group: string | null,
	index: number,
): ReadonlyArray<A> | null => {
	const groups = groupOrder(components)
	const from = groups.indexOf(group)
	const to = Math.min(Math.max(index, 0), groups.length - 1)
	if (from === -1 || from === to) return null
	const rest = Arr.filter(groups, (entry) => entry !== group)
	const order = [...Arr.take(rest, to), group, ...Arr.drop(rest, to)]
	return Arr.flatMap(order, (entry) => Arr.filter(components, (component) => component.group === entry))
}
