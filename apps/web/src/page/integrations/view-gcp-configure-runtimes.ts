import type { GcpLogRuntime } from "@maple/domain/primitives"
import { cn } from "@maple/ui/lib/utils"
import { fieldDescriptionStyles, fieldLabelStyles, fieldStyles } from "@maple/ui/styles/ui/field"
import { GCP_LOG_RUNTIMES } from "../../components/integrations/gcp-connector-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../ui/alert"
import { button } from "../../ui/button"
import * as Checkbox from "../../ui/checkbox"
import { labelIdOf } from "../../ui/choice"
import { icon } from "../../ui/icon"
import { OTEL_DOCS } from "./gcp-configure-copy"
import { Message } from "./message"
import { externalLink } from "./view-gcp-configure-parts"
import { GCP_LINK } from "./view-gcp-parts"

// `RuntimeFields`: the runtimes whose application output Google Cloud forwards.

type H = HtmlBuilder<Message>

const FORWARD_ID = "gcp-forward"

const runtimeRow = (
	h: H,
	forwardId: string,
	value: GcpLogRuntime,
	label: string,
	hint: string,
	checked: boolean,
): Html => {
	const inputId = `${forwardId}-${value}`
	return h.div(
		[
			h.Class(
				cn(
					fieldStyles,
					"grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-0.5 px-3.5 py-2.5 sm:grid-cols-[auto_11.875rem_1fr]",
				),
			),
			h.DataAttribute("slot", "field"),
		],
		[
			...Checkbox.view(h, {
				model: { isChecked: checked },
				toParentMessage: () => Message.ToggledGcpRuntime({ runtime: value }),
				id: `${inputId}-checkbox`,
				inputId,
			}),
			h.label(
				[
					h.Class(cn(fieldLabelStyles, "sm:text-sm/5")),
					h.DataAttribute("slot", "field-label"),
					h.For(inputId),
					h.Id(labelIdOf(inputId)),
				],
				[label],
			),
			h.p(
				[
					h.Class(cn(fieldDescriptionStyles, "col-start-2 text-pretty sm:col-start-3")),
					h.DataAttribute("slot", "field-description"),
				],
				[hint],
			),
		],
	)
}

/** `forwardId` names the fieldset and prefixes its checkboxes: unique per field on a page. */
export const runtimeFields = (
	h: H,
	runtimes: ReadonlyArray<GcpLogRuntime>,
	forwardId: string = FORWARD_ID,
): Html =>
	h.fieldset(
		[h.AriaLabelledBy(forwardId), h.Class("flex flex-col gap-2.5 pt-1")],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs/5")],
				[
					h.span(
						[h.Class("font-medium"), h.Id(forwardId)],
						["Forward application output from Google Cloud"],
					),
					button(
						h,
						{
							variant: "link",
							size: "xs",
							className: cn(
								"h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground active:text-foreground",
								GCP_LINK,
							),
							attributes: [h.OnClick(Message.ClickedGcpUseOpenTelemetry())],
						},
						["Use OpenTelemetry instead"],
					),
				],
			),
			h.div(
				[h.Class("divide-y rounded-md border")],
				GCP_LOG_RUNTIMES.map(({ value, label, hint }) =>
					runtimeRow(h, forwardId, value, label, hint, runtimes.includes(value)),
				),
			),
			// Maple does not know which workloads send their logs another way: the call is the admin's.
			alert(h, { variant: "warn", size: "sm", role: "note" }, [
				icon(h, "AlertWarningIcon", { size: 14 }),
				alertTitle(h, ["Only for workloads that don't send logs over OpenTelemetry"]),
				alertDescription(
					h,
					[
						"Otherwise every line arrives twice, both count toward your plan, and the Google Cloud copy has no trace link. ",
						externalLink(h, `${OTEL_DOCS}#application-output`, "Details"),
					],
					"leading-5 text-pretty",
				),
			]),
		],
	)
