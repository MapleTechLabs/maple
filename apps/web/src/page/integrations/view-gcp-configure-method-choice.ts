import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as RadioGroup from "../../ui/radio-group"
import * as ToggleGroup from "../../ui/toggle-group"
import type { ConfigureModel, SetupMethod } from "./gcp-configure-schema"
import { Message } from "./message"
import { GCP_TITLE, SMALL } from "./view-gcp-parts"

// `GcpMethodChoice`: one row per way to connect.

type H = HtmlBuilder<Message>
type Row = "script" | "manual" | "code"

const METHODS = [
	{
		value: "script",
		title: "Cloud Shell script",
		badge: "Recommended",
		description: "Runs a gcloud script in Cloud Shell. You can read it before it runs. About a minute.",
	},
	{
		value: "manual",
		title: "Manual setup",
		badge: null,
		description: "Create each resource yourself in the Google Cloud console. About 15 minutes.",
	},
	{
		value: "code",
		title: "Infrastructure as code",
		badge: null,
		description: "Generate Terraform or Alchemy config to review and apply from your own repo.",
	},
] as const

const HINTS = { terraform: "maple.tf for the google provider", alchemy: "maple.ts for alchemy/GCP" } as const

const ITEMS = METHODS.map((option) => ({
	value: option.value,
	id: `gcp-method-${option.value}`,
	inputId: `gcp-method-${option.value}-input`,
}))

const rowOf = (method: SetupMethod): Row => (method === "terraform" || method === "alchemy" ? "code" : method)

const methodOfRow = (value: string, flavour: "terraform" | "alchemy"): SetupMethod =>
	value === "code" ? flavour : value === "manual" ? "manual" : "script"

const flavourToggle = (h: H, configure: ConfigureModel, flavour: "terraform" | "alchemy"): Html =>
	h.div(
		[h.Class("flex flex-col gap-1.5 pl-7")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-3")],
				[
					ToggleGroup.view(h, {
						model: { ...configure.flavourGroup, values: [flavour] },
						toParentMessage: (message) => Message.GotGcpFlavourMessage({ message }),
						items: [
							{ value: "terraform", label: "Terraform" },
							{ value: "alchemy", label: "Alchemy" },
						],
						variant: "outline",
						size: "sm",
					}),
					h.span([h.Class(SMALL)], [HINTS[flavour]]),
				],
			),
		],
	)

/** The Method step's choice; `changing` when something of the connection is set up already. */
export const methodChoice = (h: H, configure: ConfigureModel, changing: boolean): Html => {
	const method = configure.method
	const row = rowOf(method)
	const flavour = method === "alchemy" ? "alchemy" : "terraform"
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: RadioGroup.init(row),
		toParentMessage: (message) =>
			message._tag === "CompletedFocusRadio"
				? Message.ClickedGcpMethod({ method })
				: Message.ClickedGcpMethod({ method: methodOfRow(message.value, flavour) }),
		items: ITEMS,
	}
	return h.fieldset(
		[h.Class("flex flex-col gap-3")],
		[
			h.legend(
				[h.Class(cn(GCP_TITLE, "mb-3"))],
				[changing ? "How do you want to apply the change?" : "How do you want to connect?"],
			),
			RadioGroup.radioGroup(h, { className: "gap-0 divide-y divide-border/60 rounded-md border" }, [
				...METHODS.map((option) =>
					h.div(
						[h.Key(option.value), h.Class("flex flex-col gap-3 p-4")],
						[
							h.div(
								[h.Class("flex items-start gap-3")],
								[
									...RadioGroup.radio(h, config, option.value, "mt-0.5"),
									h.label(
										[
											h.Id(RadioGroup.labelId(`gcp-method-${option.value}-input`)),
											h.For(`gcp-method-${option.value}-input`),
											h.Class("flex min-w-0 cursor-pointer flex-col gap-0.5"),
										],
										[
											h.span(
												[h.Class("flex items-baseline gap-2 text-sm font-medium")],
												[
													option.title,
													...(option.badge === null
														? []
														: [
																h.span(
																	[
																		h.Class(
																			"text-xs font-normal text-muted-foreground",
																		),
																	],
																	[option.badge],
																),
															]),
												],
											),
											h.span([h.Class(SMALL)], [option.description]),
										],
									),
								],
							),
							...(option.value === "code" && row === "code"
								? [flavourToggle(h, configure, flavour)]
								: []),
						],
					),
				),
			]),
		],
	)
}
