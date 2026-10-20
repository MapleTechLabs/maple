import { formatCurrency } from "@maple/domain/format"
import type { BillingCustomer } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { capApplies, parseCapInput, spendLimitFor } from "../../../lib/billing/controls"
import {
	FEATURE_COLORS,
	type FeatureSpend,
	featureUnit,
	rateCaption,
	SPEND_FEATURES,
	type SpendModel,
	usageMeter,
} from "../../../lib/billing/spend"
import { formatCount, formatUsage, formatUsageAgainst } from "../../../lib/billing/usage"
import { Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "../../../ui/input-group"
import { segmentedBar } from "../../../ui/meter"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { CAP_INPUT_ID, Message, type Model, SpendFeatureId } from "./model"

type H = HtmlBuilder<Message>

// `BillingUsageTable`.

/** `formatFeatureUsage`: bytes for GB features, a count otherwise. */
const featureUsage = (featureId: string, value: number): string =>
	featureUnit(featureId) === "GB" ? formatUsage(value) : formatCount(value)

/** A volume with its unit: "164.00 GB", "3,412 sessions". */
const withUnit = (featureId: string, value: number) =>
	featureUnit(featureId) === "GB" ? featureUsage(featureId, value) : `${formatCount(value)} ${featureUnit(featureId)}`

/** "164.00 GB of 100.00 GB": usage against the allotment, or what stands in for one. */
const usageLine = (feature: FeatureSpend): string => {
	const used = withUnit(feature.featureId, feature.used)
	if (feature.unlimited) return `${used}, unlimited`
	if (feature.included === null) return feature.ratePerUnit === null ? `${used}, not on your plan` : `${used}, no allotment`
	return featureUnit(feature.featureId) === "GB"
		? formatUsageAgainst(feature.used, feature.included)
		: `${formatCount(feature.used)} of ${withUnit(feature.featureId, feature.included)}`
}

export const usageTableSkeleton = (h: H): Html =>
	panel(
		h,
		{},
		SPEND_FEATURES.map((featureId) =>
			h.div(
				[h.Key(featureId), h.Class("flex items-center gap-4 border-b px-3 py-3 last:border-b-0")],
				[skeleton(h, "h-4 w-32"), skeleton(h, "h-1 flex-1"), skeleton(h, "h-4 w-16"), skeleton(h, "h-4 w-40")],
			),
		),
	)

const capEditor = (h: H, model: Model, feature: FeatureSpend): Html => {
	const parsed = parseCapInput(model.capDraft)
	return h.div(
		[h.Class("flex flex-col gap-1.5")],
		[
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					inputGroup(h, { className: "w-28" }, [
						inputGroupInput(h, {
							id: CAP_INPUT_ID,
							// Text, not number: a number input reports unparseable text as "", which reads as "no cap".
							type: "text",
							controlClassName: "font-mono tabular-nums",
							attributes: [
								h.AriaLabel(`${feature.label} paid overage cap`),
								h.InputMode("decimal"),
								h.Value(model.capDraft),
								h.Placeholder("No cap"),
								h.OnInput((value) => Message.ChangedCap({ value })),
								h.OnKeyDown((key) => Message.PressedCapKey({ key })),
							],
						}),
						inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, [featureUnit(feature.featureId)])]),
					]),
					button(
						h,
						{
							size: "sm",
							isLoading: model.isSavingCap,
							isDisabled: !parsed.valid,
							attributes: [h.OnClick(Message.ClickedSaveCap())],
						},
						["Save"],
					),
					button(
						h,
						{
							size: "sm",
							variant: "ghost",
							isDisabled: model.isSavingCap,
							attributes: [h.OnClick(Message.ClickedCancelCap())],
						},
						["Cancel"],
					),
				],
			),
			h.p(
				[h.Class(cn("text-2xs", parsed.valid ? "text-muted-foreground" : "text-destructive"))],
				[
					!parsed.valid
						? "Enter zero or more, or leave empty for no cap."
						: parsed.cap === null
							? "Empty removes the cap."
							: feature.included === null
								? "Paid overage."
								: `Paid overage. Stops at ${withUnit(feature.featureId, feature.included + parsed.cap)}`,
				],
			),
		],
	)
}

/** The cap cell at rest: the cap and where usage stops, or why a cap does not apply. */
const capSummary = (h: H, feature: FeatureSpend, cap: number | undefined): Html => {
	if (!capApplies(feature)) {
		const reason = feature.unlimited ? "Unlimited" : feature.overageAllowed === false ? "Hard cap at included" : "Not billed"
		return h.span([h.Class("text-muted-foreground")], [reason])
	}
	if (cap === undefined) return h.span([h.Class("text-muted-foreground")], ["Uncapped"])
	const isReached = feature.overageUnits > 0 && feature.overageUnits >= cap
	return h.div(
		[h.Class("flex min-w-0 flex-col")],
		[
			h.span([h.Class("font-mono tabular-nums")], [cap === 0 ? "No overage" : `+${withUnit(feature.featureId, cap)}`]),
			h.span(
				[h.Class(cn("text-2xs", isReached ? "text-severity-error" : "text-muted-foreground"))],
				[
					isReached
						? "Cap reached, new data rejected"
						: feature.included === null
							? "Paid overage"
							: `Stops at ${withUnit(feature.featureId, feature.included + cap)}`,
				],
			),
		],
	)
}

const featureRow = (h: H, model: Model, spend: SpendModel, customer: BillingCustomer, feature: FeatureSpend): Html => {
	const cap = spendLimitFor(customer, feature.featureId)?.overageLimit
	const isHardCapped = feature.overageAllowed === false && !feature.unlimited
	const hasOverage = feature.overageUnits > 0 && !isHardCapped
	const meter = usageMeter(feature)
	const isEditing = model.editingCap === feature.featureId
	const featureId = Option.getOrNull(Schema.decodeUnknownOption(SpendFeatureId)(feature.featureId))
	const color = FEATURE_COLORS[feature.featureId]
	return tableRow(
		h,
		[
			tableCell(h, [
				h.div(
					[h.Class("flex min-w-0 items-center gap-2")],
					[
						h.span([h.AriaHidden(true), h.Class("size-2 shrink-0 rounded-full"), h.Style({ background: color })]),
						h.span([h.Class("truncate")], [feature.label]),
					],
				),
			]),
			tableCell(h, [
				h.div(
					[h.Class("flex min-w-0 flex-col gap-1.5")],
					[
						segmentedBar(h, {
							className: "h-1 w-full rounded-none bg-muted",
							total: 100,
							segments: [
								{ key: "included", value: meter.included, color },
								{ key: "overage", value: meter.overage, className: "bg-primary" },
							],
						}),
						h.span([h.Class("truncate font-mono text-2xs tabular-nums text-muted-foreground")], [usageLine(feature)]),
					],
				),
			]),
			tableCell(
				h,
				[
					h.div(
						[h.Class("flex flex-col items-end")],
						[
							h.span(
								[h.Class(cn("font-mono tabular-nums", !hasOverage && "text-muted-foreground"))],
								[
									isHardCapped && feature.overageUnits > 0
										? "Rejected"
										: formatCurrency(feature.overageCents / 100, spend.currency),
								],
							),
							h.span([h.Class("font-mono text-2xs tabular-nums text-muted-foreground")], [rateCaption(feature)]),
						],
					),
				],
				"text-right",
			),
			tableCell(h, [
				isEditing
					? capEditor(h, model, feature)
					: h.div(
							[h.Class("flex items-center justify-between gap-2")],
							[
								capSummary(h, feature, cap),
								...(model.isAdmin && capApplies(feature) && featureId !== null
									? [
											button(
												h,
												{
													size: "sm",
													variant: "ghost",
													isDisabled: model.isSavingCap,
													attributes: [
														h.AriaLabel(`Edit ${feature.label} cap`),
														h.OnClick(Message.ClickedEditCap({ featureId })),
													],
												},
												["Edit"],
											),
										]
									: []),
							],
						),
			]),
		],
		cn(isEditing && "bg-muted/40"),
		[h.Key(feature.featureId)],
	)
}

/** One row per billable feature: included vs overage, its cost, and the paid overage cap. */
export const usageTable = (h: H, model: Model, spend: SpendModel, customer: BillingCustomer): Html =>
	panel(h, {}, [
		table(h, {}, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Feature"], "w-44"),
					tableHead(h, ["Usage"]),
					tableHead(h, ["Overage"], "w-28 text-right"),
					tableHead(h, ["Overage cap"], "w-60"),
				]),
			]),
			tableBody(
				h,
				spend.features.map((feature) => featureRow(h, model, spend, customer, feature)),
			),
		]),
	])
