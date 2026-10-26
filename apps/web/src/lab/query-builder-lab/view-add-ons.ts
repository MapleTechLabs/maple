import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { lookupField } from "../../page/kit/autocomplete-lookups"
import { QueryChange, type QueryTextField } from "../../page/kit/query-builder/change"
import type { QueryDraft } from "../../page/kit/query-builder/draft"
import { textInput } from "../../page/kit/query-builder/parts"
import { view as comboboxView } from "../../ui/combobox-view"
import { groupByOptionsOf } from "./derive"
import { Message, type Model } from "./model"
import { groupByModelOf } from "./update-controls"
import { labelEyebrow, labSelect } from "./view-controls"

// The inputs each enabled add-on reveals under a lab query.

type H = HtmlBuilder<Message>

const GROUP_BY_PLACEHOLDER = "service.name | span.name | none | attr.http.route"

/** `autocompleteValues.attributeKeys`: the span attribute keys, empty until they load. */
const spanAttributeKeysOf = (model: Model): ReadonlyArray<string> =>
	lookupField(
		Option.getOrUndefined(
			Option.flatMap(Option.fromNullishOr(model.autocomplete["spanAttributeKeys"]), (slot) =>
				AsyncData.getData(slot.data),
			),
		),
		"keys",
	)

/** `GroupByAutocomplete`. TODO(lab-query-builder): items lack `font-mono` (the item class). */
const groupBy = (h: H, model: Model, query: QueryDraft): Html =>
	h.submodel({
		slotId: `query-builder-lab-group-by-${query.id}`,
		model: { ...groupByModelOf(model, query), selected: query.groupBy.slice(0, 1) },
		view: comboboxView,
		toParentMessage: (message) => Message.GotGroupByMessage({ queryId: query.id, message }),
		viewInputs: {
			items: groupByOptionsOf(query.dataSource, spanAttributeKeysOf(model)),
			placeholder: GROUP_BY_PLACEHOLDER,
			emptyText: "No fields found.",
			className: "h-8 text-xs",
			isUnfiltered: true,
			toView: ({ field, rest }) =>
				h.div([h.Class("space-y-1")], [labelEyebrow(h, "Group by"), field, ...rest]),
		},
	})

const textField = (
	h: H,
	query: QueryDraft,
	title: string,
	field: QueryTextField,
	placeholder: string,
	type?: string,
): Html =>
	h.div(
		[h.Class("space-y-1")],
		[
			labelEyebrow(h, title),
			textInput(
				h,
				`${field}-${query.id}`,
				query[field],
				placeholder,
				"",
				(value) =>
					Message.ChangedQuery({
						queryId: query.id,
						change: QueryChange.SetText({ field, value }),
					}),
				type,
			),
		],
	)

const DIRECTIONS = [
	{ value: "desc", label: "desc" },
	{ value: "asc", label: "asc" },
]

const orderBy = (h: H, model: Model, query: QueryDraft): Html =>
	h.div(
		[h.Class("grid gap-2 md:grid-cols-[1fr_1fr]")],
		[
			textField(h, query, "Order by (UI-only)", "orderBy", "p95(duration)"),
			labSelect(h, model, `orderDirection:${query.id}`, query.orderByDirection, DIRECTIONS, {
				className: "w-full",
				toView: (parts) => h.div([h.Class("space-y-1")], [labelEyebrow(h, "Direction"), ...parts]),
			}),
		],
	)

export const addOnSections = (h: H, model: Model, query: QueryDraft): ReadonlyArray<Html> => [
	...(query.addOns.groupBy ? [groupBy(h, model, query)] : []),
	...(query.addOns.having ? [textField(h, query, "Having (UI-only)", "having", "count() > 10")] : []),
	...(query.addOns.orderBy ? [orderBy(h, model, query)] : []),
	...(query.addOns.limit ? [textField(h, query, "Limit (UI-only)", "limit", "10", "number")] : []),
	...(query.addOns.legend
		? [textField(h, query, "Legend format (UI-only)", "legend", "{{service.name}} - {{status.code}}")]
		: []),
]
