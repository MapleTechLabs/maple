import type { Html, HtmlBuilder } from "foldkit/html"
import * as Autocomplete from "../../../ui/autocomplete"
import type * as Combobox from "../../../ui/combobox"
import { chipsView } from "../../../ui/combobox-view"
import type * as Select from "../../../ui/select"
import { type SelectEntry, view as selectView } from "../../../ui/select-view"
import { Message } from "./model"

// apps/web/src/lab/kit/pickers.tsx: the select, combobox and autocomplete fixtures, open on mount.
type H = HtmlBuilder<Message>

const itemRow = (h: H, children: ReadonlyArray<Html>) =>
	h.div([h.Class("flex min-h-48 items-start")], children)

export const ENVIRONMENT_ENTRIES: ReadonlyArray<SelectEntry> = [
	{
		_tag: "Group",
		label: "Deployed",
		items: [
			{ value: "production", label: "Production" },
			{ value: "staging", label: "Staging" },
		],
	},
	{ _tag: "Separator" },
	{ _tag: "Item", item: { value: "development", label: "Development" } },
]

export const SERVICES = ["api-gateway", "checkout-svc", "payment-svc", "inventory-svc", "notification-svc"]

export const kitComboboxChips = (h: H, model: Combobox.Model): Html =>
	h.submodel({
		slotId: "combobox",
		model,
		view: chipsView,
		viewInputs: {
			items: SERVICES,
			ariaLabel: "Services",
			placeholder: "Add a service",
			emptyText: "No services found.",
			className: "w-96",
			toView: (parts) => itemRow(h, parts),
		},
		toParentMessage: (message) => Message.GotComboboxMessage({ message }),
	})

export const kitAutocomplete = (h: H, model: Autocomplete.Model): Html =>
	h.submodel({
		slotId: "autocomplete",
		model,
		view: Autocomplete.view,
		viewInputs: {
			items: SERVICES,
			ariaLabel: "Search services",
			placeholder: "Search services",
			emptyText: "No matches.",
			toView: ({ field, rest }) => itemRow(h, [h.div([h.Class("w-64")], [field]), ...rest]),
		},
		toParentMessage: (message) => Message.GotAutocompleteMessage({ message }),
	})

export const kitSelect = (h: H, model: Select.Model): Html =>
	h.submodel({
		slotId: "select",
		model,
		view: selectView,
		viewInputs: {
			entries: ENVIRONMENT_ENTRIES,
			ariaLabel: "Environment",
			className: "w-56",
			toView: (parts) => itemRow(h, parts),
		},
		toParentMessage: (message) => Message.GotSelectMessage({ message }),
	})
