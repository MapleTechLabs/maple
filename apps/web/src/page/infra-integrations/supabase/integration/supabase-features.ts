import type { SupabaseIntegrationStatus } from "@maple/domain/http"
import { Option, Array as Arr } from "effect"
import { lifecycleOf } from "../health"
import type { PendingSupabaseSwitch, SupabaseSwitchKind } from "./supabase"

// What each project's Metrics, Logs and Drain switches show and allow, for the project rows and
// for the integration's Features list, which sets one switch on every project.

type Project = SupabaseIntegrationStatus["projects"][number]

export type ProjectSwitches = Readonly<{
	/** Paused, or a write for the project is in flight. */
	isLocked: boolean
	/** Each switch's value; a flip in flight shows its intended value. */
	values: Readonly<Record<SupabaseSwitchKind, boolean>>
	/** Whether each switch, off, could be turned on. */
	canEnable: Readonly<Record<SupabaseSwitchKind, boolean>>
}>

/** A drain to Maple set up in Supabase: it already delivers, and a managed one would double it. */
export const hasManualMapleDrain = (project: Project): boolean =>
	Arr.some(project.logDrains, (drain) => drain.toMaple && !drain.managedByMaple)

export const projectSwitches = (
	pending: ReadonlyArray<PendingSupabaseSwitch>,
	project: Project,
): ProjectSwitches => {
	const entry = Arr.findFirst(pending, (candidate) => candidate.ref === project.ref)
	const pendingOf = (kind: SupabaseSwitchKind) => Option.filter(entry, (found) => found.kind === kind)
	const isLocked = lifecycleOf(project.status)._tag === "Paused" || Option.isSome(entry)
	const metrics = Option.match(pendingOf("metrics"), {
		onNone: () => project.metricsEnabled,
		onSome: (found) => found.enabled,
	})
	const drain = Option.match(pendingOf("drain"), {
		onNone: () => project.logDrainEnabled,
		onSome: (found) => found.enabled,
	})
	// Turning a drain on stops polling server-side; show that while the write is in flight.
	const logs = Option.match(pendingOf("logs"), {
		onNone: () => (drain ? false : project.logsEnabled),
		onSome: (found) => found.enabled,
	})
	const manual = hasManualMapleDrain(project)
	return {
		isLocked,
		values: { metrics, logs, drain },
		// A drain already delivers the project's logs; polling too would store them twice.
		canEnable: { metrics: true, logs: !drain && !manual, drain: !manual },
	}
}

/** A feature across every project: how many have it on, and the projects a flip would write. */
export type FeatureAcross = Readonly<{
	onCount: number
	total: number
	/** On while no project that could have it is without it. */
	isChecked: boolean
	/** The projects a flip writes: the unlocked ones whose switch would change. */
	targets: ReadonlyArray<Project["ref"]>
	isSaving: boolean
	/** Why no project can be flipped, when none can and nothing is saving; the row is disabled. */
	blockedReason: string | null
}>

/** Why a project without the feature cannot have it, by switch kind. */
const CANNOT_ENABLE = {
	metrics: "No project can collect metrics",
	logs: "Logs already come through a drain",
	drain: "A drain to Maple is already set up in Supabase",
} as const satisfies Record<SupabaseSwitchKind, string>

export const featureAcross = (
	pending: ReadonlyArray<PendingSupabaseSwitch>,
	projects: ReadonlyArray<Project>,
	kind: SupabaseSwitchKind,
): FeatureAcross => {
	const states = Arr.map(projects, (project) => ({ project, ...projectSwitches(pending, project) }))
	const onCount = Arr.filter(states, (state) => state.values[kind]).length
	const isChecked =
		onCount > 0 &&
		!Arr.some(states, (state) => !state.values[kind] && state.canEnable[kind] && !state.isLocked)
	const enabled = !isChecked
	const targets = Arr.map(
		Arr.filter(
			states,
			(state) =>
				!state.isLocked && state.values[kind] !== enabled && (!enabled || state.canEnable[kind]),
		),
		(state) => state.project.ref,
	)
	const isSaving = Arr.some(pending, (entry) => entry.kind === kind)
	const blocked = Arr.filter(states, (state) => state.values[kind] !== enabled)
	const blockedReason =
		targets.length > 0 || isSaving
			? null
			: projects.length === 0
				? "No projects yet"
				: enabled && Arr.some(blocked, (state) => !state.canEnable[kind])
					? CANNOT_ENABLE[kind]
					: Arr.every(blocked, (state) => lifecycleOf(state.project.status)._tag === "Paused")
						? "Every project is paused"
						: "Another change is saving"
	return { onCount, total: projects.length, isChecked, targets, isSaving, blockedReason }
}
