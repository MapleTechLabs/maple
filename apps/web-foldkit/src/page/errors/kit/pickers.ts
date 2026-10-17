import type { IssueSeverity, WorkflowState } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { SEVERITY_LABEL, severityIcon } from "./severity"
import { WORKFLOW_LABEL, workflowRingIcon } from "./workflow"

// The closed triggers of `SeverityPicker` and `StatePicker` (components/errors/issue-pickers.tsx).
// TODO(quick-pick): the `QuickPickMenu` popover (type-to-filter, digits, mutations) is not ported.

const TRIGGER =
	"rounded-md transition-colors hover:bg-foreground/8 data-popup-open:bg-foreground/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"

/** `PopoverTrigger`'s closed-state attributes. */
const popoverTrigger = <M>(h: HtmlBuilder<M>) => [
	h.AriaExpanded(false),
	h.AriaHasPopup("dialog"),
	h.DataAttribute("base-ui-click-trigger", ""),
	h.DataAttribute("slot", "popover-trigger"),
	h.Tabindex(0),
	h.Type("button"),
]

export const severityPickerTrigger = <M>(
	h: HtmlBuilder<M>,
	value: IssueSeverity | null,
	className?: string,
): Html => {
	const label = value === null ? "Severity not set" : `Severity: ${SEVERITY_LABEL[value]}`
	return h.button(
		[
			...popoverTrigger(h),
			h.AriaLabel(`${label}. Change severity`),
			h.Class(cn(TRIGGER, "inline-flex size-6 items-center justify-center", className)),
			h.DataAttribute("picker", "severity"),
			h.Title(`${label} · click to change`),
		],
		[severityIcon(h, value, 16)],
	)
}

export const statePickerTrigger = <M>(h: HtmlBuilder<M>, current: WorkflowState, className?: string): Html =>
	h.button(
		[
			...popoverTrigger(h),
			h.Class(
				cn(
					TRIGGER,
					"-ml-1.5 inline-flex h-6 max-w-full items-center gap-1.5 px-1.5 text-2xs whitespace-nowrap text-muted-foreground hover:text-foreground data-popup-open:text-foreground",
					className,
				),
			),
			h.DataAttribute("picker", "state"),
			h.Title(`Status: ${WORKFLOW_LABEL[current]} · click to change`),
		],
		[
			workflowRingIcon(h, current, 12, "shrink-0"),
			h.span([h.Class("truncate")], [WORKFLOW_LABEL[current]]),
		],
	)
