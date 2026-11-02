import type { GcpProjectHealth } from "../../../../components/infra/gcp/list-model"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html } from "foldkit/html"
import { pressable } from "../../../../ui/pressable"
import { heroFieldChipClass, heroFieldChipParts } from "../../../infra/kit/hero-chip"
import type * as Menu from "../../../../ui/menu"
import * as MenuView from "../../../../ui/menu-view"
import { statusDot } from "../../../../ui/status-dot"
import { Message } from "./model"
import type { H } from "./view-rows"

// `GcpProjectMenu`: with two or more projects the title's chip picks one of them, or all.

export const ALL_PROJECTS = "__all__"
export const MANAGE_CONNECTIONS = "manage-connections"

const healthText = (health: GcpProjectHealth | undefined) =>
	health === undefined || health.tone === "ok" || health.tone === "neutral"
		? "text-muted-foreground"
		: TONE_TEXT[health.tone]

const projectItem = (
	h: H,
	project: string,
	counts: string,
	health: GcpProjectHealth | undefined,
): ReadonlyArray<Html> => [
	h.span(
		[h.Class("flex items-start gap-2")],
		[
			h.span(
				[h.Class("mt-1.5 flex w-1.5 shrink-0")],
				health === undefined ? [] : [statusDot(h, { tone: health.tone })],
			),
			h.span(
				[h.Class("flex flex-col")],
				[
					h.span([h.Class("font-mono")], [project]),
					h.span(
						[h.Class(cn("text-3xs", healthText(health)))],
						health === undefined ? [counts] : [counts, ` · ${health.message}`],
					),
				],
			),
		],
	),
]

export const projectMenu = (
	h: H,
	options: Readonly<{
		model: Menu.Model
		projects: ReadonlyArray<string>
		/** What each project holds: "9 services · 2 databases". */
		counts: (project: string) => string
		health: ReadonlyMap<string, GcpProjectHealth>
		/** A project, or undefined for all of them. */
		value: string | undefined
	}>,
): Html => {
	const { value } = options
	return h.submodel({
		slotId: "gcp-project-menu",
		model: options.model,
		view: MenuView.view,
		toParentMessage: (message) => Message.GotProjectMenuMessage({ message }),
		viewInputs: {
			align: "start",
			className: "min-w-80",
			// Two radio groups around the separator.
			entries: [
				{
					_tag: "RadioGroup",
					items: [{ value: ALL_PROJECTS, label: "All projects", isChecked: value === undefined }],
				},
				{ _tag: "Separator" },
				{
					_tag: "RadioGroup",
					items: options.projects.map((project) => ({
						value: project,
						label: project,
						isChecked: value === project,
						content: projectItem(
							h,
							project,
							options.counts(project),
							options.health.get(project),
						),
					})),
				},
				{ _tag: "Separator" },
				{ _tag: "Item", value: MANAGE_CONNECTIONS, label: "Manage connections" },
			],
			toView: ({ trigger, withTrigger }) =>
				h.span(
					[h.Class("contents")],
					withTrigger(
						pressable(
							h,
							{ className: heroFieldChipClass(true), attributes: [h.Tabindex(0), ...trigger] },
							// "All 3 projects", or just the picked project's name.
							heroFieldChipParts(
								h,
								value === undefined
									? {
											label: "projects",
											value: `All ${options.projects.length}`,
											isValueFirst: true,
											isPicker: true,
										}
									: { label: "", value, isPicker: true },
							),
						),
					),
				),
		},
	})
}
