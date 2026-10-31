import {
	allowedTransitionsForAll,
	type IssueSeverity,
	MACHINE_OWNED_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
	type WorkflowState,
} from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import type { QuickPickItem } from "./quick-pick"
import { SEVERITY_LABEL, SEVERITY_ORDER, severityIcon } from "./severity"
import { WORKFLOW_LABEL, workflowRingIcon } from "./workflow"

// The severity and state pickers: their triggers and the
// rows their `QuickPickMenu` offers.

export type PickerKind = "severity" | "state"

/** Hotkeys shown in the pickers and handled by the hub on the focused row. */
export const PICKER_HOTKEY = { severity: "P", state: "S" } as const

const TRIGGER =
	"rounded-md hover:bg-surface-sunken active:bg-surface-sunken data-popup-open:bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"

/** `PopoverTrigger`'s closed-state attributes; an open popover supplies its own. */
const closedTrigger = <M>(h: HtmlBuilder<M>) => [
	h.AriaExpanded(false),
	h.AriaHasPopup("dialog"),
	h.DataAttribute("base-ui-click-trigger", ""),
	h.DataAttribute("slot", "popover-trigger"),
	h.Tabindex(0),
]

/** `trigger`: the open Popover's attributes, or the closed trigger's own click. */
export type TriggerAttributes<M> =
	| Readonly<{ isOpen: boolean; attributes: ReadonlyArray<ChildAttribute> }>
	| Readonly<{ isOpen: false; onClick: M }>

const triggerAttributes = <M>(h: HtmlBuilder<M>, trigger: TriggerAttributes<M> | undefined) =>
	trigger === undefined
		? closedTrigger(h)
		: "attributes" in trigger
			? trigger.attributes
			: [...closedTrigger(h), h.OnClick(trigger.onClick)]

export const severityPickerTrigger = <M>(
	h: HtmlBuilder<M>,
	value: IssueSeverity | null,
	className?: string,
	trigger?: TriggerAttributes<M>,
): Html => {
	const label = value === null ? "Severity not set" : `Severity: ${SEVERITY_LABEL[value]}`
	return h.button(
		[
			...triggerAttributes(h, trigger),
			h.Type("button"),
			h.AriaLabel(`${label}. Change severity`),
			h.Class(cn(TRIGGER, "inline-flex size-6 items-center justify-center", className)),
			h.DataAttribute("picker", "severity"),
			h.Title(`${label} · click to change`),
		],
		[severityIcon(h, value, 16)],
	)
}

export const statePickerTrigger = <M>(
	h: HtmlBuilder<M>,
	current: WorkflowState,
	className?: string,
	trigger?: TriggerAttributes<M>,
): Html =>
	h.button(
		[
			...triggerAttributes(h, trigger),
			h.Type("button"),
			h.Class(
				cn(
					TRIGGER,
					"-ml-1.5 inline-flex h-6 max-w-full items-center gap-1.5 px-1.5 text-2xs whitespace-nowrap text-muted-foreground hover:text-foreground active:text-foreground data-popup-open:text-foreground",
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

/** `SEVERITY_ITEMS`: "No severity" on 0, the levels on 1 to 4. */
export const severityItems = <M>(h: HtmlBuilder<M>): ReadonlyArray<QuickPickItem> => [
	{
		value: "none",
		label: "No severity",
		icon: severityIcon(h, null),
		shortcut: "0",
		keywords: "none unset clear",
	},
	...SEVERITY_ORDER.map((severity, index) => ({
		value: severity,
		label: SEVERITY_LABEL[severity],
		icon: severityIcon(h, severity),
		shortcut: String(index + 1),
	})),
]

/** `regressed` and `verifying` are set by the ticks, never chosen. */
const OFFERED_STATES = WORKFLOW_STATE_ORDER.filter((state) => !MACHINE_OWNED_WORKFLOW_STATES.has(state))

/** Unreachable states stay listed but dimmed: the digits mean the same on every row. */
export const stateItems = <M>(h: HtmlBuilder<M>, current: WorkflowState): ReadonlyArray<QuickPickItem> => {
	const allowed = new Set<WorkflowState>(allowedTransitionsForAll([current]))
	return OFFERED_STATES.map((state, index) => ({
		value: state,
		label: WORKFLOW_LABEL[state],
		icon: workflowRingIcon(h, state, 14),
		shortcut: String(index + 1),
		isDisabled: state !== current && !allowed.has(state),
	}))
}
