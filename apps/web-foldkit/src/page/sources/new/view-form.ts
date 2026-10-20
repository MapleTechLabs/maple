import type { PushSourcePlatform } from "@maple/domain/primitives"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { type FieldIds, type FieldState, field, fieldLabel, input } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { defaultSourceName, platformMeta, platformTile } from "../kit/platforms"
import { rulesOutcome } from "../kit/rules"
import * as RulesView from "../kit/rules-view"
import { Message } from "./message"
import type { Model } from "./model"

// `CreateSourceForm`: step 2.

type H = HtmlBuilder<Message>

const NAME_IDS: FieldIds = { control: "source-name", label: "source-name-label", error: "source-name-error" }
const ADVANCED_PANEL_ID = "source-advanced-panel"

const nameState = (model: Model, platform: PushSourcePlatform): FieldState => ({
	isInvalid: false,
	isDirty: model.name !== defaultSourceName(platform),
	isFilled: model.name !== "",
	isFocused: false,
	isTouched: false,
})

const header = (h: H, platform: PushSourcePlatform): Html =>
	h.div(
		[h.Class("flex items-center gap-3")],
		[
			platformTile(h, platform),
			h.div(
				[h.Class("flex min-w-0 flex-col")],
				[
					h.span([h.Class("text-sm font-medium")], [platformMeta(platform).label]),
					h.span([h.Class("text-muted-foreground text-xs")], [platformMeta(platform).description]),
				],
			),
		],
	)

const nameField = (h: H, model: Model, platform: PushSourcePlatform): Html => {
	const state = nameState(model, platform)
	return field(h, { state }, [
		fieldLabel(h, { ids: NAME_IDS, state }, "Name"),
		input(h, {
			ids: NAME_IDS,
			state,
			attributes: [
				h.Value(model.name),
				h.Attribute("maxlength", "100"),
				h.OnInput((value) => Message.ChangedName({ value })),
			],
		}),
	])
}

/** `<Collapsible>` with the "Advanced" trigger; closed, Base UI renders no panel. */
const advanced = (h: H, model: Model): Html => {
	const isOpen = model.isAdvancedOpen
	return h.div(
		[h.DataAttribute(isOpen ? "open" : "closed", ""), h.DataAttribute("slot", "collapsible")],
		[
			h.button(
				[
					...(isOpen ? [h.AriaControls(ADVANCED_PANEL_ID)] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(isOpen),
					h.Class("text-muted-foreground hover:text-foreground group flex items-center gap-1.5 text-sm"),
					...(isOpen ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					h.OnClick(Message.ToggledAdvanced()),
				],
				[
					icon(h, "ChevronRightIcon", {
						size: 14,
						className: "transition-transform group-data-[panel-open]:rotate-90",
					}),
					"Advanced",
				],
			),
			...(isOpen
				? [
						h.div(
							[
								h.Class(collapsiblePanelStyles),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id(ADVANCED_PANEL_ID),
								h.Style({ "--collapsible-panel-height": "auto", "--collapsible-panel-width": "auto", "animation-name": "none" }),
							],
							[
								panel(h, { padded: true, className: "mt-3" }, [
									RulesView.view(h, {
										model: model.rules,
										toParentMessage: (message) => Message.GotRulesMessage({ message }),
										idPrefix: "source",
										nowMs: 0,
									}),
								]),
							],
						),
					]
				: []),
		],
	)
}

export const createSourceForm = (h: H, model: Model, platform: PushSourcePlatform): Html => {
	const isValid = model.name.trim().length > 0 && rulesOutcome(model.rules).valid
	return h.form(
		[h.Class("flex w-full max-w-2xl flex-col gap-4"), h.OnSubmit(Message.SubmittedForm())],
		[
			panel(h, { padded: true, className: "gap-4" }, [header(h, platform), nameField(h, model, platform)]),
			advanced(h, model),
			h.footer(
				[h.Class("flex items-center gap-3 border-t pt-4")],
				[
					h.span([h.Class("text-muted-foreground grow text-xs")], ["The token is shown once, on the next step."]),
					button(h, { variant: "outline", attributes: [h.OnClick(Message.ClickedBack())] }, ["Back"]),
					button(h, { type: "submit", isDisabled: !isValid, isLoading: model.isSaving }, ["Create source"]),
				],
			),
		],
	)
}
