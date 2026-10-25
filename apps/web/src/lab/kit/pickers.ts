import type { Html, HtmlBuilder } from "foldkit/html"
import * as Autocomplete from "../../ui/autocomplete"
import * as Combobox from "../../ui/combobox"
import { chipsView, view as comboboxView } from "../../ui/combobox-view"
import { icon } from "../../ui/icon"
import * as Select from "../../ui/select"
import { type SelectEntry, selectedIndexOf, view as selectView } from "../../ui/select-view"

// apps/web/src/lab/kit/pickers.ts: the select, combobox and autocomplete fixtures shared by the
// forms page (closed) and the overlays page (open). `place` positions each one's parts.

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

export const initKitSelect = (id: string, isOpen = false): Select.Model =>
	Select.init(id, {
		value: "staging",
		selectedIndex: selectedIndexOf(ENVIRONMENT_ENTRIES, "staging"),
		isOpen,
	})

export const initKitCombobox = (id: string, isOpen = false): Combobox.Model =>
	Combobox.init(id, "single", { selected: ["payment-svc"], isOpen })

export const initKitComboboxChips = (id: string, isOpen = false): Combobox.Model =>
	Combobox.init(id, "multiple", { selected: ["checkout-svc", "payment-svc"], isOpen })

export const initKitAutocomplete = (id: string, isOpen = false): Combobox.Model =>
	Combobox.init(id, "autocomplete", { isOpen })

type Place = (parts: ReadonlyArray<Html>) => Html

/** `<div className="w-64">` around a field, then its hidden input and portal. */
const sized =
	<M>(h: HtmlBuilder<M>, place: Place) =>
	(parts: Readonly<{ field: Html; rest: ReadonlyArray<Html> }>) =>
		place([h.div([h.Class("w-64")], [parts.field]), ...parts.rest])

export const kitSelect = <M>(
	h: HtmlBuilder<M>,
	model: Select.Model,
	toParentMessage: (message: Select.Message) => M,
	place: Place,
): Html =>
	h.submodel({
		slotId: model.id,
		model,
		view: selectView,
		viewInputs: {
			entries: ENVIRONMENT_ENTRIES,
			ariaLabel: "Environment",
			className: "w-56",
			toView: place,
		},
		toParentMessage,
	})

export const kitCombobox = <M>(
	h: HtmlBuilder<M>,
	model: Combobox.Model,
	toParentMessage: (message: Combobox.Message) => M,
	place: Place,
): Html =>
	h.submodel({
		slotId: model.id,
		model,
		view: comboboxView,
		viewInputs: {
			items: SERVICES,
			ariaLabel: "Service",
			placeholder: "Pick a service",
			emptyText: "No services found.",
			startAddon: icon(h, "MagnifierIcon"),
			toView: sized(h, place),
		},
		toParentMessage,
	})

export const kitComboboxChips = <M>(
	h: HtmlBuilder<M>,
	model: Combobox.Model,
	toParentMessage: (message: Combobox.Message) => M,
	place: Place,
): Html =>
	h.submodel({
		slotId: model.id,
		model,
		view: chipsView,
		viewInputs: {
			items: SERVICES,
			ariaLabel: "Services",
			placeholder: "Add a service",
			emptyText: "No services found.",
			className: "w-96",
			toView: place,
		},
		toParentMessage,
	})

export const kitAutocomplete = <M>(
	h: HtmlBuilder<M>,
	model: Combobox.Model,
	toParentMessage: (message: Combobox.Message) => M,
	place: Place,
): Html =>
	h.submodel({
		slotId: model.id,
		model,
		view: Autocomplete.view,
		viewInputs: {
			items: SERVICES,
			ariaLabel: "Search services",
			placeholder: "Search services",
			emptyText: "No matches.",
			toView: sized(h, place),
		},
		toParentMessage,
	})
