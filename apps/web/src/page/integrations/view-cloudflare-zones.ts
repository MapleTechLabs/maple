import { countLabel } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../ui/alert"
import { button } from "../../ui/button"
import * as Checkbox from "../../ui/checkbox"
import { formDialog } from "../../ui/form-dialog"
import { icon } from "../../ui/icon"
import { searchInput } from "../../ui/search-input"
import * as Switch from "../../ui/switch"
import type { ZoneChoice } from "./cloudflare"
import { Message } from "./message"
import type { Model } from "./model"

// "Manage zones": which of each connected account's zones Maple collects.

type H = HtmlBuilder<Message>

const zoneRow = (h: H, accountId: string, zone: ZoneChoice["zones"][number]): Html => {
	const inputId = `cf-zone-${accountId}-${zone.id}`
	return h.label(
		[
			h.Key(inputId),
			h.Id(Checkbox.labelId(inputId)),
			h.Class("flex min-w-0 items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-surface-sunken active:bg-surface-sunken"),
		],
		[
			...Checkbox.view(h, {
				model: { isChecked: zone.watched },
				toParentMessage: () => Message.ToggledManagedZone({ accountId, zoneId: zone.id }),
				id: `${inputId}-root`,
				inputId,
			}),
			h.span([h.Class("truncate")], [zone.name]),
		],
	)
}

const accountSection = (h: H, account: ZoneChoice, query: string, isMulti: boolean): Html => {
	const shown = account.zones.filter((zone) => query === "" || zone.name.toLowerCase().includes(query))
	const watched = account.zones.filter((zone) => zone.watched).length
	const switchInputId = `cf-zones-new-${account.accountId}`
	const selectLink = (label: string, value: boolean) =>
		button(
			h,
			{
				variant: "link",
				size: "xs",
				className: "h-auto p-0 text-xs font-normal",
				isDisabled: shown.length === 0,
				attributes: [
					h.OnClick(
						Message.ClickedSetAccountZones({ accountId: account.accountId, watched: value }),
					),
				],
			},
			[label],
		)
	return h.section(
		[h.Key(account.accountId), h.Class("flex flex-col gap-2")],
		[
			...(isMulti
				? [h.h3([h.Class("text-sm font-semibold")], [account.accountName ?? account.accountId])]
				: []),
			h.label(
				[
					h.Id(Switch.labelId(switchInputId)),
					h.Class("flex items-center justify-between gap-3 text-sm"),
				],
				[
					h.span([], ["Collect new zones automatically"]),
					...Switch.switchControl(h, {
						id: `${switchInputId}-root`,
						inputId: switchInputId,
						isChecked: account.watchNewZones,
						labelledBy: Switch.labelId(switchInputId),
						onToggle: Message.ToggledWatchNewZones({ accountId: account.accountId }),
					}),
				],
			),
			h.div(
				[h.Class("flex items-center gap-3 text-xs text-muted-foreground")],
				[
					h.span(
						[h.Class("mr-auto")],
						[`${watched} of ${countLabel(account.zones.length, "zone")} collected`],
					),
					selectLink("Select all", true),
					selectLink("Select none", false),
				],
			),
			shown.length === 0
				? h.p(
						[
							h.Class(
								"rounded-md border border-border-subtle px-3 py-4 text-xs text-muted-foreground",
							),
						],
						[account.zones.length === 0 ? "No zones found yet" : "No zones match these filters"],
					)
				: h.div(
						[
							h.Class(
								"flex max-h-64 flex-col overflow-y-auto overscroll-contain rounded-md border border-border-subtle py-1",
							),
						],
						shown.map((zone) => zoneRow(h, account.accountId, zone)),
					),
		],
	)
}

export const zonesDialog = (h: H, model: Model): Html => {
	const card = model.cloudflareCard
	const query = card.zoneDraftSearch.trim().toLowerCase()
	const isMulti = card.zoneDraft.length > 1
	const zoneCount = card.zoneDraft.reduce((sum, account) => sum + account.zones.length, 0)
	return formDialog(h, {
		slotId: "cloudflare-zones",
		model: card.zoneDialog,
		toParentMessage: (message) => Message.GotZoneDialogMessage({ message }),
		title: "Manage zones",
		description:
			"Maple collects analytics only for checked zones. Data already collected for a paused zone stays.",
		onSubmit: Message.SubmittedZoneSettings(),
		submitLabel: "Save",
		isPending: card.isSavingZones,
		panelClassName: "flex flex-col gap-5",
		fields: [
			...(zoneCount > 8
				? [
						searchInput(h, {
							id: "cloudflare-zones-search",
							value: card.zoneDraftSearch,
							placeholder: "Filter zones…",
							onInput: (value) => Message.ChangedManagedZoneSearch({ value }),
							onClear: Message.ChangedManagedZoneSearch({ value: "" }),
							attributes: [h.AriaLabel("Filter zones by name")],
						}),
					]
				: []),
			...card.zoneDraft.map((account) => accountSection(h, account, query, isMulti)),
			...(card.zoneSaveError === null
				? []
				: [
						alert(h, { variant: "crit" }, [
							icon(h, "CircleWarningIcon"),
							alertDescription(h, [card.zoneSaveError]),
						]),
					]),
		],
	})
}
