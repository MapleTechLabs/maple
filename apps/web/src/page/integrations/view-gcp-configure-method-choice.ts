import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { label } from "@maple/views/ui/label"
import * as RadioGroup from "@maple/views/ui/radio-group"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import type { ConfigureModel, SetupMethod } from "./gcp-configure-schema"
import { Message } from "./message"
import { GCP_TITLE, SMALL } from "./view-gcp-parts"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { typography } from "@maple/views/ui/typography"

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

const ITEMS = Arr.map(METHODS, (option) => ({
	value: option.value,
	id: `gcp-method-${option.value}`,
	inputId: `gcp-method-${option.value}-input`,
}))

const rowOf = (method: SetupMethod): Row => (method === "terraform" || method === "alchemy" ? "code" : method)

const methodOfRow = (value: string, flavour: "terraform" | "alchemy"): SetupMethod =>
	value === "code" ? flavour : value === "manual" ? "manual" : "script"

const flavourToggle = (h: H, configure: ConfigureModel, flavour: "terraform" | "alchemy"): Html =>
	vstack(h, { gap: "1.5", className: "pl-7" }, [
		hstack(h, { gap: "3", wrap: true }, [
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
		]),
	])

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
		[h.Class(vstackClass({ gap: "3" }))],
		[
			h.legend(
				[h.Class(cn(GCP_TITLE, "mb-3"))],
				[changing ? "How do you want to apply the change?" : "How do you want to connect?"],
			),
			RadioGroup.radioGroup(
				h,
				{ className: "gap-0 divide-y divide-border-subtle rounded-md border" },
				Arr.map(METHODS, (option) =>
					vstack(h, { gap: "3", className: "p-4", attributes: [h.Key(option.value)] }, [
						hstack(h, { gap: "3", align: "start" }, [
							...RadioGroup.radio(h, config, option.value, "mt-0.5"),
							label(
								h,
								{
									className:
										"flex min-w-0 cursor-pointer flex-col items-stretch gap-0.5 font-normal",
									attributes: [
										h.Id(RadioGroup.labelId(`gcp-method-${option.value}-input`)),
										h.For(`gcp-method-${option.value}-input`),
									],
								},
								[
									hstack(
										h,
										{
											gap: "2",
											align: "baseline",
											as: "span",
											className: "text-sm font-medium",
										},
										[
											option.title,
											...(option.badge === null
												? []
												: [
														typography(
															h,
															{ size: "xs", tone: "muted", weight: "normal" },
															[option.badge],
														),
													]),
										],
									),
									h.span([h.Class(SMALL)], [option.description]),
								],
							),
						]),
						...(option.value === "code" && row === "code"
							? [flavourToggle(h, configure, flavour)]
							: []),
					]),
				),
			),
		],
	)
}
