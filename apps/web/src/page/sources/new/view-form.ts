import { isPublicSourcePlatform, type PushSourcePlatform } from "@maple/domain/primitives"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { collapsible } from "@maple/views/ui/collapsible"
import { flowColumns, stepCard } from "../../kit/connect-flow"
import { type FieldIds, type FieldState, field, fieldLabel, input } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import { defaultSourceName } from "../kit/platforms"
import { rulesOutcome } from "../kit/rules"
import * as RulesView from "../kit/rules-view"
import { Message } from "./message"
import type { FlowHost, Model } from "./model"
import { flowFooter } from "./view-footer"
import { howItWorksRail } from "./view-push-rail"
import { typography } from "@maple/views/ui/typography"
import { String as Str } from "effect"

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
const advanced = (h: H, model: Model): Html =>
	collapsible(
		h,
		{
			isOpen: model.isAdvancedOpen,
			onToggle: Message.ToggledAdvanced(),
			panelId: ADVANCED_PANEL_ID,
			triggerClassName:
				"text-muted-foreground hover:text-foreground active:text-foreground group flex items-center gap-1.5 text-sm",
			trigger: [
				icon(h, "ChevronRightIcon", {
					size: 14,
					className: "transition-transform group-data-[panel-open]:rotate-90",
				}),
				"Advanced",
			],
		},
		[
			h.div(
				[h.Class("mt-4 border-t border-border pt-4")],
				[
					RulesView.view(h, {
						model: model.rules,
						toParentMessage: (message) => Message.GotRulesMessage({ message }),
						idPrefix: "source",
						nowMs: 0,
					}),
				],
			),
		],
	)

export const createSourceForm = (h: H, model: Model, platform: PushSourcePlatform, host: FlowHost): Html => {
	const isValid = Str.trim(model.name).length > 0 && rulesOutcome(model.rules).valid
	return h.form(
		[h.Class("flex w-full flex-1 flex-col gap-4"), h.OnSubmit(Message.SubmittedForm())],
		[
			flowColumns(
				h,
				[
					stepCard(
						h,
						{
							icon: "KeyIcon",
							title: "Name the source",
							note: isPublicSourcePlatform(platform) ? "Public token" : "Write-only token",
						},
						[
							typography(h, { size: "xs", tone: "muted", as: "p" }, [
								isPublicSourcePlatform(platform)
									? "Your site sends data to Maple with this source's public token. It ships in your client code, which is safe: it can only write to this source, never read."
									: "Your app sends data to Maple with this source's token. It can only write to this source, never read.",
							]),
							nameField(h, model, platform),
							advanced(h, model),
						],
					),
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
