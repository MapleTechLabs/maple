import { type BuildingType, serviceBuildingId } from "@maple/domain/http"
import type { Topology3D } from "../../components/service-map/three/types"
import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { BUILDINGS, buildingsFor, defaultBuilding } from "./factory/catalog"
import { canRedo, canUndo, ResetAll, ResetBuilding, SetBuildingType } from "./factory/edits"
import { sceneToCell } from "./factory/grid"
import { Message, type Model } from "./scene3d"
import type { CustomLayout } from "./scene-layout"

// Customize mode's DOM: the toolbar controls beside the perspective toggle and the panel that
// sets the selected building's type. Moving happens on the canvas (`three/move-tool.ts`).

const saveStatus = <M>(h: HtmlBuilder<M>, model: Model, toMessage: (message: Message) => M): Html =>
	model.isSaveFailed
		? hstack(h, { gap: "1.5", as: "span" }, [
				typography(h, { size: "2xs", tone: "error", attributes: [h.AriaLive("polite")] }, [
					"Not saved",
				]),
				button(
					h,
					{
						size: "xs",
						variant: "outline",
						attributes: [h.OnClick(toMessage(Message.ClickedRetrySave()))],
					},
					["Retry"],
				),
			])
		: model.isConflicted && !model.isSaving
			? typography(h, { size: "2xs", tone: "warning", attributes: [h.AriaLive("polite")] }, [
					"A teammate changed this first, showing theirs",
				])
			: model.rejection !== null && !model.isSaving
				? typography(
						h,
						{
							size: "2xs",
							tone: "error",
							attributes: [h.AriaLive("polite"), h.Title(model.rejection)],
						},
						["Change not allowed, undone"],
					)
				: typography(h, { size: "2xs", tone: "muted", attributes: [h.AriaLive("polite")] }, [
						model.isSaving ? "Saving…" : "Saved for your org",
					])

/** Customize (or, while customizing, undo, redo, reset, save state and Done) for the bar. */
export const customizeControls = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	toMessage: (message: Message) => M,
): ReadonlyArray<Html> => {
	if (model.worldState === "failed")
		return [
			hstack(h, { gap: "1.5", as: "span", className: "ml-3" }, [
				typography(h, { size: "2xs", tone: "muted" }, ["Saved layout didn't load"]),
				button(
					h,
					{
						size: "xs",
						variant: "outline",
						attributes: [h.OnClick(toMessage(Message.ClickedRetryLoad()))],
					},
					["Retry"],
				),
			]),
		]
	if (!model.isEditing)
		return [
			button(
				h,
				{
					size: "sm",
					variant: "ghost",
					className: "text-xs",
					isDisabled: model.worldState !== "ready" || model.isFailed,
					attributes: [h.OnClick(toMessage(Message.ClickedCustomize()))],
				},
				[icon(h, "PencilIcon"), "Customize"],
			),
		]
	const edits = model.world.value
	return [
		hstack(h, { gap: "1", className: "ml-3" }, [
			iconButton(
				h,
				{
					size: "icon-xs",
					label: "Undo",
					isDisabled: !canUndo(edits),
					attributes: [h.OnClick(toMessage(Message.ClickedUndo()))],
				},
				[icon(h, "UndoIcon")],
			),
			iconButton(
				h,
				{
					size: "icon-xs",
					label: "Redo",
					isDisabled: !canRedo(edits),
					attributes: [h.OnClick(toMessage(Message.ClickedRedo()))],
				},
				[icon(h, "RedoIcon")],
			),
			button(
				h,
				{
					size: "xs",
					variant: "ghost",
					isDisabled: !Arr.some(
						[...edits.local.values()],
						(entity) => entity._tag === "ServiceBuilding",
					),
					attributes: [
						h.OnClick(toMessage(Message.EditedWorld({ command: ResetAll.make({}) }))),
						h.Title("Put every building back in its automatic place"),
					],
				},
				["Reset all"],
			),
			saveStatus(h, model, toMessage),
		]),
		button(
			h,
			{
				size: "sm",
				variant: "default",
				className: "text-xs",
				attributes: [h.OnClick(toMessage(Message.ClickedDoneCustomizing()))],
			},
			["Done"],
		),
	]
}

export type EditPanelOptions<M> = Readonly<{
	model: Model
	topology: Topology3D
	selectedId: string | null
	custom: CustomLayout
	className: string
	toMessage: (message: Message) => M
}>

/** The selected building's type picker and reset, top right of the paper while customizing. */
export const editPanel = <M>(h: HtmlBuilder<M>, options: EditPanelOptions<M>): Html | null => {
	const { model, topology, selectedId, custom, toMessage } = options
	if (!model.isEditing) return null
	const node = Arr.findFirst(topology.nodes, (candidate) => candidate.id === selectedId)
	const position = Option.flatMap(node, (found) =>
		Option.fromUndefinedOr(custom.layout.positions.get(found.id)),
	)
	if (Option.isNone(node) || Option.isNone(position))
		return h.div(
			[h.Class(`pointer-events-none absolute top-4 right-4 max-w-56 px-3 py-2 ${options.className}`)],
			[
				typography(h, { size: "2xs" }, [
					"Drag a building to move it. Click one to change what it looks like.",
				]),
			],
		)
	const { id, label, kind } = node.value
	const cell = sceneToCell(position.value)
	const stored = model.world.value.local.get(serviceBuildingId(id))
	const override = stored === undefined ? null : stored.building
	const choose = (building: BuildingType | null) =>
		h.OnClick(
			toMessage(Message.EditedWorld({ command: SetBuildingType.make({ nodeId: id, building, cell }) })),
		)
	const option = (value: BuildingType | null, text: string, description: string) =>
		button(
			h,
			{
				size: "xs",
				variant: override === value ? "outline" : "ghost",
				className: "w-full justify-start",
				attributes: [h.AriaPressed(String(override === value)), h.Title(description), choose(value)],
			},
			[text],
		)
	const fallback = BUILDINGS[defaultBuilding(node.value)]
	return vstack(
		h,
		{
			gap: "1",
			className: `pointer-events-auto absolute top-4 right-4 w-56 p-2 ${options.className}`,
			attributes: [h.Role("group"), h.AriaLabel(`Customize ${label}`)],
		},
		[
			heading(h, { level: 3, variant: "label", className: "truncate px-1 text-current" }, [label]),
			option(null, `Automatic (${fallback.label})`, "Follow the node's kind"),
			...Arr.map(buildingsFor(kind), (building) =>
				option(building, BUILDINGS[building].label, BUILDINGS[building].description),
			),
			button(
				h,
				{
					size: "xs",
					variant: "ghost",
					className: "mt-1 w-full justify-start",
					isDisabled: stored === undefined,
					attributes: [
						h.OnClick(
							toMessage(Message.EditedWorld({ command: ResetBuilding.make({ nodeId: id }) })),
						),
					],
				},
				[icon(h, "ArrowRotateAnticlockwiseIcon"), "Reset building"],
			),
		],
	)
}
