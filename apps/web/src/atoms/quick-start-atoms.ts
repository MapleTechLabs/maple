import { ONBOARDING_INTENT_IDS, type OnboardingIntent } from "@/lib/onboarding-intent"
import { ONBOARDING_ROLE_IDS, type OnboardingRole } from "@/lib/onboarding-role"
import { Atom } from "@/lib/effect-atom"
import { Schema, SchemaGetter } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export const STEP_IDS = ["role", "intent", "team", "plan"] as const

export type StepId = (typeof STEP_IDS)[number]

// Resume persisted sessions whose active step has since been removed.
export function resolveQuickStartStep(state: Pick<QuickStartState, "activeStep" | "completedSteps">): StepId {
	return (
		STEP_IDS.find((step) => step === state.activeStep) ??
		STEP_IDS.find((step) => !state.completedSteps[step]) ??
		"plan"
	)
}

export interface QualifyAnswers {
	role: OnboardingRole | null
	/** Free text behind the "other" role; empty for every named role. */
	roleDetail: string
	intents: readonly OnboardingIntent[]
}

export interface QuickStartState {
	completedSteps: Record<string, boolean>
	dismissed: boolean
	selectedFramework: string | null
	activeStep: string
	qualifyAnswers: QualifyAnswers
	checklistDismissed: boolean
	checklistExpanded: boolean
}

const IntentSchema = Schema.Literals(ONBOARDING_INTENT_IDS)
// The first wizard asked for themes rather than surfaces; a resumed session
// keeps its answer by landing on the surface each theme was really about.
const StoredIntentSchema = Schema.Literals([
	...ONBOARDING_INTENT_IDS,
	"slow_requests",
	"consolidate",
	"visibility",
])
const CURRENT_INTENT = {
	traces: "traces",
	logs: "logs",
	metrics: "metrics",
	errors: "errors",
	replays: "replays",
	service_map: "service_map",
	infrastructure: "infrastructure",
	alerts: "alerts",
	slow_requests: "traces",
	consolidate: "logs",
	visibility: "service_map",
} as const satisfies Record<typeof StoredIntentSchema.Type, OnboardingIntent>
const RoleSchema = Schema.NullOr(Schema.Literals(ONBOARDING_ROLE_IDS))
// "engineer" predates the backend/frontend split; it always meant backend.
const StoredRoleSchema = Schema.NullOr(Schema.Literals([...ONBOARDING_ROLE_IDS, "engineer"]))
const currentRole = (stored: typeof StoredRoleSchema.Type): OnboardingRole | null =>
	stored === "engineer" ? "backend" : stored

// Normalize older single-choice and themed saves at the storage boundary; always write arrays.
export const QualifyAnswersSchema = Schema.Struct({
	role: StoredRoleSchema,
	roleDetail: Schema.optionalKey(Schema.String),
	intent: Schema.optionalKey(Schema.NullOr(StoredIntentSchema)),
	intents: Schema.optionalKey(Schema.Array(StoredIntentSchema)),
}).pipe(
	Schema.decodeTo(
		Schema.Struct({ role: RoleSchema, roleDetail: Schema.String, intents: Schema.Array(IntentSchema) }),
		{
			decode: SchemaGetter.transform(({ role, roleDetail, intent, intents }) => ({
				role: currentRole(role),
				roleDetail: roleDetail ?? "",
				intents: [
					...new Set((intents ?? (intent ? [intent] : [])).map((stored) => CURRENT_INTENT[stored])),
				],
			})),
			encode: SchemaGetter.transform(({ role, roleDetail, intents }) => ({
				role,
				roleDetail,
				intents,
			})),
		},
	),
)

const QuickStartSchema = Schema.Struct({
	completedSteps: Schema.Record(Schema.String, Schema.Boolean),
	dismissed: Schema.Boolean,
	selectedFramework: Schema.NullOr(Schema.String),
	activeStep: Schema.String,
	qualifyAnswers: QualifyAnswersSchema,
	checklistDismissed: Schema.Boolean,
	checklistExpanded: Schema.Boolean,
}) as Schema.Codec<QuickStartState>

export const DEFAULT_QUICK_START_STATE: QuickStartState = {
	completedSteps: {},
	dismissed: false,
	selectedFramework: null,
	activeStep: "role",
	qualifyAnswers: { role: null, roleDetail: "", intents: [] },
	checklistDismissed: false,
	checklistExpanded: true,
}

export const quickStartAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple-onboarding-v6-${orgId}`,
		schema: QuickStartSchema,
		defaultValue: () => DEFAULT_QUICK_START_STATE,
	}),
)
