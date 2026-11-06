import { Array as Arr, Option, String as Str } from "effect"
export const TRIAL_DURATION_DAYS = 14

const DEFAULT_PLAN = "starter"

export interface PlanFeature {
	icon: string
	label: string
	value: string
}

const PLAN_FEATURES: Record<string, PlanFeature[]> = {
	starter: [
		{ icon: "clock", label: "Data retention", value: "7 days" },
		{ icon: "grid", label: "Dashboards", value: "Unlimited" },
		{ icon: "bell", label: "Alerting", value: "Advanced" },
		{ icon: "code", label: "API access", value: "Full" },
		{ icon: "shield", label: "Support", value: "Email" },
	],
	startup: [
		{ icon: "clock", label: "Data retention", value: "30 days" },
		{ icon: "grid", label: "Dashboards", value: "Unlimited" },
		{ icon: "bell", label: "Alerting", value: "Advanced" },
		{ icon: "code", label: "API access", value: "Full" },
		{ icon: "shield", label: "Support", value: "Private channel" },
	],
	enterprise: [
		{ icon: "clock", label: "Data retention", value: "Custom" },
		{ icon: "grid", label: "Dashboards", value: "Unlimited" },
		{ icon: "bell", label: "Alerting", value: "Enterprise" },
		{ icon: "code", label: "API access", value: "Full" },
		{ icon: "shield", label: "Support", value: "Priority" },
	],
} satisfies Record<string, PlanFeature[]>

export function getPlanFeatures(planSlug: string | undefined): PlanFeature[] {
	return PLAN_FEATURES[planSlug ?? DEFAULT_PLAN] ?? PLAN_FEATURES[DEFAULT_PLAN] ?? []
}

const STARTUP_DESCRIPTION = "For growing teams"

const PLAN_DESCRIPTIONS: Record<string, string> = {
	starter: "For individuals and small projects",
	startup: STARTUP_DESCRIPTION,
} satisfies Record<string, string>

export function getPlanDescription(planSlug: string): string {
	return PLAN_DESCRIPTIONS[planSlug] ?? STARTUP_DESCRIPTION
}

/**
 * A catalog plan name in the UI's sentence case: "Bring Your Own Cloud" reads
 * "Bring your own cloud". Words with inner capitals ("OpenRouter") or acronyms stay.
 */
export function sentenceCasePlanName(name: string): string {
	return Arr.join(
		Arr.map(Str.split(" ")(name), (word, index) =>
			index === 0 || !/^[A-Z][a-z]+$/.test(word) ? word : Str.toLowerCase(word),
		),
		" ",
	)
}

/** A plan id ("bringyourowncloud") as a readable name: the catalog's, else the slug spaced out. */
export function planDisplayName(
	planId: string,
	catalog: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): string {
	return Option.match(
		Arr.findFirst(catalog, (plan) => plan.id === planId),
		{
			onSome: (plan) => sentenceCasePlanName(plan.name),
			onNone: () => {
				const spaced = Str.trim(Str.replace(/[_-]+/g, " ")(planId))
				return Str.toUpperCase(Str.slice(0, 1)(spaced)) + Str.slice(1)(spaced)
			},
		},
	)
}
