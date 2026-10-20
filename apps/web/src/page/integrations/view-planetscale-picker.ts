import { cn } from "@maple/ui/lib/utils"
import { isExcluded } from "../../components/infra/planetscale/branch-selection"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import * as DialogView from "../../ui/dialog-view"
import * as Field from "../../ui/field"
import { inlineCode } from "../../ui/inline-code"
import { skeleton } from "../../ui/skeleton"
import { Message } from "./message"
import type { Model } from "./model"
import { parsePatternList } from "./planetscale"

// `PlanetScaleOrgPicker` and `OptionCard` / `DrawnCheck`. The check is drawn at its end state.

type H = HtmlBuilder<Message>

const drawnCheck = (h: H, isChecked: boolean, className: string): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"flex size-4 shrink-0 items-center justify-center rounded-sm border transition-[color,background-color,border-color,opacity] duration-150 motion-reduce:transition-none",
					isChecked
						? "border-primary bg-primary text-primary-foreground"
						: "border-input bg-background group-hover:border-foreground/40",
					className,
				),
			),
		],
		[
			h.svg(
				[h.Attribute("viewBox", "0 0 24 24"), h.Class("size-3"), h.Attribute("fill", "none")],
				[
					h.path([
						h.Attribute("d", "M5.252 12.7 10.2 18.63 18.748 5.37"),
						h.Attribute("stroke", "currentColor"),
						h.Attribute("stroke-width", "3"),
						h.Attribute("stroke-linecap", "round"),
						h.Attribute("stroke-linejoin", "round"),
						h.Attribute("pathLength", "1"),
						h.Attribute("stroke-dashoffset", "0px"),
						h.Attribute("stroke-dasharray", isChecked ? "1px 1px" : "0px 1px"),
						h.Attribute("opacity", isChecked ? "1" : "0"),
					]),
				],
			),
		],
	)

/** `OptionCard type="radio" layout="row"`. */
const optionCard = (h: H, name: string, isChecked: boolean): Html =>
	h.label(
		[h.Class("group relative cursor-pointer")],
		[
			h.input([
				h.Type("radio"),
				h.Name("planetscale-organization"),
				h.Class("peer sr-only"),
				h.Checked(isChecked),
				h.AriaLabel(name),
				h.OnChange(() => Message.SelectedOrganization({ name })),
			]),
			h.div(
				[
					h.Class(
						cn(
							"flex h-full rounded-md border transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
							"items-start gap-3 p-4",
							!isChecked
								? "border-border group-hover:border-foreground/30 group-hover:bg-foreground/[0.02]"
								: "border-primary bg-primary/5",
						),
					),
				],
				[
					h.div(
						[h.Class("min-w-0 flex-1 pt-px")],
						[
							h.span(
								[h.Class("block text-sm font-semibold")],
								[h.span([h.Class("truncate")], [name])],
							),
						],
					),
					drawnCheck(h, isChecked, cn("mt-0.5", !isChecked && "opacity-0")),
				],
			),
		],
	)

const branchField = (
	h: H,
	model: Model,
	field: "include" | "exclude",
	options: Readonly<{
		id: string
		label: string
		placeholder: string
		description: ReadonlyArray<Html | string>
	}>,
): Html => {
	const fieldModel =
		field === "include" ? model.planetscaleCard.includeBranches : model.planetscaleCard.excludeBranches
	const state = Field.stateOf(fieldModel, false)
	const ids: Field.FieldIds = {
		control: options.id,
		label: `${options.id}-label`,
		error: `${options.id}-error`,
		description: `${options.id}-description`,
	}
	return Field.field(h, { className: "items-stretch gap-1.5", state }, [
		Field.fieldLabel(h, { ids, state }, options.label),
		Field.input(h, {
			ids,
			state,
			attributes: [
				h.Placeholder(options.placeholder),
				h.Autocomplete("off"),
				...Field.controlAttributes(h, fieldModel, (message) =>
					Message.GotBranchFieldMessage({ field, message }),
				),
			],
		}),
		Field.fieldDescription(h, { ids, state }, options.description),
	])
}

/** The live filter preview over the inventory's branch names. */
const previewOf = (model: Model) => {
	const inventory = model.statuses.planetscaleDatabases.data
	const names =
		AsyncData.isSuccess(inventory) || AsyncData.isRefreshing(inventory)
			? [...new Set(inventory.data.databases.flatMap((db) => db.branches.map((branch) => branch.name)))]
			: []
	const include = parsePatternList(model.planetscaleCard.includeBranches.value)
	const exclude = parsePatternList(model.planetscaleCard.excludeBranches.value)
	if (names.length === 0 || (include.length === 0 && exclude.length === 0)) return null
	const dropped = names.filter((name) => isExcluded(name, include, exclude))
	return { total: names.length, kept: names.length - dropped.length, dropped }
}

export const orgPicker = (h: H, model: Model, cancelLabel: string): Html => {
	const card = model.planetscaleCard
	const organizations = card.organizations.data
	if (AsyncData.isIdle(organizations) || AsyncData.isLoading(organizations))
		return skeleton(h, "h-24 w-full")
	if (AsyncData.isFailure(organizations) || AsyncData.isStale(organizations))
		return h.p(
			[h.Class("text-xs text-muted-foreground")],
			[
				"Couldn't list the authorized PlanetScale organizations — the authorization may have been revoked. Disconnect and connect again.",
			],
		)
	const preview = previewOf(model)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			h.div(
				[
					h.Class("flex flex-col gap-1.5"),
					h.Role("radiogroup"),
					h.AriaLabel("PlanetScale organization"),
				],
				organizations.data.organizations.map((org) =>
					optionCard(h, org.name, card.selectedOrg === org.name),
				),
			),
			h.div(
				[h.Class("flex flex-col gap-3")],
				[
					branchField(h, model, "include", {
						id: "ps-include-branches",
						label: "Only these branches (optional)",
						placeholder: "main, staging",
						description: [
							"Leave blank to collect every branch. When set, only matching branches are collected — exclusions still apply on top.",
						],
					}),
					branchField(h, model, "exclude", {
						id: "ps-exclude-branches",
						label: "Exclude branches (optional)",
						placeholder: "pr-*, preview-*",
						description: [
							"Glob patterns — ",
							inlineCode(h, {}, ["*"]),
							" matches any run, ",
							inlineCode(h, {}, ["?"]),
							" ",
							"exactly one character.",
						],
					}),
					...(preview === null
						? []
						: [
								h.p(
									[h.Class("text-xs text-muted-foreground")],
									[
										h.span(
											[h.Class("font-medium text-foreground")],
											[String(preview.kept), " of ", String(preview.total)],
										),
										" ",
										"branches will be collected",
										...(preview.dropped.length > 0
											? [
													" — skipping ",
													h.span(
														[h.Class("font-mono")],
														[preview.dropped.slice(0, 6).join(", ")],
													),
													preview.dropped.length > 6
														? ` and ${preview.dropped.length - 6} more`
														: "",
												]
											: []),
									],
								),
							]),
				],
			),
			DialogView.dialogFooter(h, "dialog", [
				button(
					h,
					{
						variant: "outline",
						isDisabled: card.isSelecting,
						attributes: [h.OnClick(Message.ClickedPickerCancel())],
					},
					[cancelLabel],
				),
				button(
					h,
					{
						isDisabled: card.selectedOrg === null,
						isLoading: card.isSelecting,
						attributes: [h.OnClick(Message.SubmittedOrganization())],
					},
					["Connect organization"],
				),
			]),
		],
	)
}

/** The "Change PlanetScale organization" dialog around the picker. */
export const pickerDialog = (h: H, model: Model): Html => {
	const id = model.planetscaleCard.pickerDialog.id
	return h.submodel({
		slotId: "planetscale-org-picker",
		model: model.planetscaleCard.pickerDialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			className: "sm:max-w-md",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", id, "Change PlanetScale organization"),
					DialogView.dialogDescription(
						h,
						"dialog",
						id,
						"Pick another organization the authorization covers. Metrics collection follows automatically.",
					),
				]),
				DialogView.dialogPanel(h, "dialog", id, [orgPicker(h, model, "Cancel")]),
			],
		},
		toParentMessage: (message) => Message.GotPickerDialogMessage({ message }),
	})
}
