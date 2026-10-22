import { makeOnboardingTeamActions } from "../../components/onboarding/team-actions"
import { Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { clerkTeamOrganization, clerkTry } from "../../platform/clerk"

// `StepTeamConnected` / `StepTeam` (apps/web/src/components/onboarding): rename the workspace and
// invite teammates through the Clerk organization, or the self-hosted notice.

const Operation = Schema.Literals(["rename", "invite"])

export const Team = Schema.Struct({
	/** `!isLoaded || invitations.isLoading`: "Loading your workspace…". */
	isLoaded: Schema.Boolean,
	name: Schema.String,
	savedName: Schema.String,
	email: Schema.String,
	invited: Schema.Array(Schema.String),
	feedback: Schema.NullOr(Schema.Struct({ message: Schema.String, isError: Schema.Boolean })),
	pending: Schema.NullOr(Operation),
	canManage: Schema.Boolean,
	unavailableReason: Schema.NullOr(Schema.String),
})
export type Team = typeof Team.Type

export const ready = (
	name: string,
	invited: ReadonlyArray<string>,
	canManage: boolean,
	reason: string | null,
): Team => ({
	isLoaded: true,
	name,
	savedName: name,
	email: "",
	invited,
	feedback: null,
	pending: null,
	canManage,
	unavailableReason: reason,
})

export const selfHostedTeam = (): Team =>
	ready("My workspace", [], false, "Team invitations are managed by your hosting administrator.")

export const loadingTeam = (): Team => ({ ...selfHostedTeam(), isLoaded: false, unavailableReason: null })

const ADMIN_ONLY =
	"An organization admin can rename this workspace and invite teammates. You can continue with setup."

export const TeamMessage = defineMessageUnion({
	LoadedTeam: { name: Schema.String, canManage: Schema.Boolean, invitations: Schema.Array(Schema.String) },
	ChangedWorkspaceName: { value: Schema.String },
	ChangedTeammateEmail: { value: Schema.String },
	SubmittedRename: {},
	SubmittedInvite: {},
	SucceededTeamOperation: { operation: Operation, value: Schema.String },
	FailedTeamOperation: { message: Schema.String },
})
export type TeamMessage = typeof TeamMessage.Type

/** `useOrganization({ invitations })`: the org's name and, for an admin, its pending invitations. */
export const LoadTeam = Command.define("LoadOnboardingTeam", {
	messages: [TeamMessage.LoadedTeam],
	execute: Effect.gen(function* () {
		const maybeOrganization = yield* clerkTeamOrganization
		if (Option.isNone(maybeOrganization))
			return TeamMessage.LoadedTeam({ name: "My workspace", canManage: false, invitations: [] })
		const organization = maybeOrganization.value
		const invitations = organization.isAdmin
			? yield* clerkTry("Failed to load invitations", organization.pendingInvitations).pipe(
					Effect.orElseSucceed(() => []),
				)
			: []
		return TeamMessage.LoadedTeam({
			name: organization.name,
			canManage: organization.isAdmin,
			invitations,
		})
	}),
})

/** `actions.rename` / `actions.invite` (`makeOnboardingTeamActions`) on the active organization. */
export const RunTeamOperation = Command.define("RunOnboardingTeamOperation", {
	args: { operation: Operation, value: Schema.String },
	messages: [TeamMessage.SucceededTeamOperation, TeamMessage.FailedTeamOperation],
	execute: ({ operation, value }) =>
		Effect.gen(function* () {
			const maybeOrganization = yield* clerkTeamOrganization
			if (Option.isNone(maybeOrganization))
				return TeamMessage.FailedTeamOperation({ message: "Something went wrong. Please try again." })
			const actions = makeOnboardingTeamActions(maybeOrganization.value)
			yield* operation === "rename" ? actions.rename(value) : actions.invite(value)
			return TeamMessage.SucceededTeamOperation({ operation, value })
		}).pipe(
			Effect.catchTag("@maple/web/OnboardingTeamError", (error) =>
				Effect.succeed(TeamMessage.FailedTeamOperation({ message: error.message })),
			),
		),
})

export const isNameDirty = (team: Team): boolean => team.name.trim() !== team.savedName

export const isAlreadyInvited = (team: Team): boolean =>
	team.invited.some((address) => address.toLowerCase() === team.email.trim().toLowerCase())

type TeamStep = Readonly<{ team: Team; commands: ReadonlyArray<Command.Command<TeamMessage>> }>

/** One operation at a time: a second submit while one is pending is dropped. */
const run = (team: Team, operation: "rename" | "invite", value: string): TeamStep => ({
	team: { ...team, pending: operation, feedback: null },
	commands: [RunTeamOperation({ operation, value })],
})

export const updateTeam = (team: Team, message: TeamMessage): TeamStep =>
	TeamMessage.match<TeamStep>(message, {
		LoadedTeam: ({ name, canManage, invitations }) => ({
			team: ready(name, invitations, canManage, canManage ? null : ADMIN_ONLY),
			commands: [],
		}),
		ChangedWorkspaceName: ({ value }) => ({ team: { ...team, name: value }, commands: [] }),
		ChangedTeammateEmail: ({ value }) => ({ team: { ...team, email: value }, commands: [] }),
		SubmittedRename: () =>
			!team.canManage || team.pending !== null || team.name.trim() === "" || !isNameDirty(team)
				? { team, commands: [] }
				: run(team, "rename", team.name.trim()),
		SubmittedInvite: () =>
			!team.canManage || team.pending !== null || team.email.trim() === "" || isAlreadyInvited(team)
				? { team, commands: [] }
				: run(team, "invite", team.email.trim()),
		SucceededTeamOperation: ({ operation, value }) => ({
			team:
				operation === "rename"
					? {
							...team,
							pending: null,
							name: value,
							savedName: value,
							feedback: {
								message: "Workspace name saved. Make yourself at home.",
								isError: false,
							},
						}
					: {
							...team,
							pending: null,
							email: "",
							invited: [...team.invited, value],
							feedback: { message: `Invitation sent to ${value}.`, isError: false },
						},
			commands: [],
		}),
		FailedTeamOperation: ({ message: failure }) => ({
			team: { ...team, pending: null, feedback: { message: failure, isError: true } },
			commands: [],
		}),
	})
