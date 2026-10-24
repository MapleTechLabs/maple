import type { PushSourcePlatform } from "@maple/domain/primitives"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { flowColumns, stepCard } from "../../kit/connect-flow"
import { type FieldIds, type FieldState, field, fieldLabel, input } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { defaultSourceName } from "../kit/platforms"
import { rulesOutcome } from "../kit/rules"
import * as RulesView from "../kit/rules-view"
import { Message } from "./message"
import type { FlowHost, Model } from "./model"
import { flowFooter } from "./view-footer"
import { howItWorksRail } from "./view-push-rail"

// `CreateSourceForm`: the Name step. Create submits; the token shows on Send data.

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
					h.Class(
						"text-muted-foreground hover:text-foreground group flex items-center gap-1.5 text-sm",
					),
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
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
									"animation-name": "none",
								}),
							],
							[
								h.div(
									[h.Class("mt-4 border-t border-border pt-4")],
									[
										RulesView.view(h, {
											model: model.rules,
											toParentMessage: (message) =>
												Message.GotRulesMessage({ message }),
											idPrefix: "source",
											nowMs: 0,
										}),
									],
								),
							],
						),
					]
				: []),
		],
	)
}

export const createSourceForm = (h: H, model: Model, platform: PushSourcePlatform, host: FlowHost): Html => {
	const isValid = model.name.trim().length > 0 && rulesOutcome(model.rules).valid
	return h.form(
		[h.Class("flex w-full flex-1 flex-col gap-4"), h.OnSubmit(Message.SubmittedForm())],
		[
			flowColumns(
				h,
				[
					stepCard(h, { icon: "KeyIcon", title: "Name the source", note: "Write-only token" }, [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Your app sends data to Maple with this source's token. It can only write to this source, never read.",
							],
						),
						nameField(h, model, platform),
						advanced(h, model),
					]),
				],
				howItWorksRail(h, platform),
			),
			flowFooter(h, {
				back: Message.ClickedBack(),
				hint: "The token is shown once, on the next step.",
				host,
				actions: [
					button(h, { type: "submit", isDisabled: !isValid, isLoading: model.isSaving }, [
						"Create source",
						icon(h, "ArrowRightIcon", { size: 14 }),
					]),
				],
			}),
		],
	)
}
