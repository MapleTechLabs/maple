import { Effect, Schema } from "effect"

export class OnboardingTeamError extends Schema.TaggedError<OnboardingTeamError>()(
	"@maple/web/OnboardingTeamError",
	{
		message: Schema.String,
		operation: Schema.Literals(["rename", "invite"]),
		cause: Schema.Defect(),
	},
) {}

export interface OnboardingTeamActions {
	rename: (name: string) => Effect.Effect<void, OnboardingTeamError>
	invite: (email: string) => Effect.Effect<void, OnboardingTeamError>
}

export function makeOnboardingTeamActions<Workspace, Invitation>(organization: {
	update: (input: { name: string }) => Promise<Workspace>
	inviteMember: (input: { emailAddress: string; role: "org:member" }) => Promise<Invitation>
}): OnboardingTeamActions {
	return {
		rename: (name) =>
			Effect.tryPromise({
				try: () => organization.update({ name }),
				catch: (cause) =>
					new OnboardingTeamError({
						operation: "rename",
						message: "Couldn't save the workspace name. Check your permissions and try again.",
						cause,
					}),
			}).pipe(Effect.asVoid),
		invite: (email) =>
			Effect.tryPromise({
				try: () => organization.inviteMember({ emailAddress: email, role: "org:member" }),
				catch: (cause) =>
					new OnboardingTeamError({
						operation: "invite",
						message:
							"Couldn't send the invitation. Check the email and your permissions, then try again.",
						cause,
					}),
			}).pipe(Effect.asVoid),
	}
}
