import { useAuth, useOrganization } from "@clerk/clerk-react"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { StepTeam } from "./step-team"
import { makeOnboardingTeamActions } from "./team-actions"

export function StepTeamConnected(props: { onContinue: () => void; onBack: () => void }) {
	if (!isClerkAuthEnabled)
		return (
			<StepTeam
				{...props}
				initialName="My workspace"
				unavailableReason="Team invitations are managed by your hosting administrator."
			/>
		)
	return <ClerkTeamStep {...props} />
}

function ClerkTeamStep(props: { onContinue: () => void; onBack: () => void }) {
	const { orgRole } = useAuth()
	const { organization, invitations, isLoaded } = useOrganization({
		invitations: orgRole === "org:admin" ? { infinite: true, status: ["pending"] } : undefined,
	})
	if (!isLoaded || invitations?.isLoading)
		return (
			<output className="p-12 text-center text-sm text-muted-foreground">
				Loading your workspace…
			</output>
		)
	const canManage = orgRole === "org:admin" && organization != null
	return (
		<StepTeam
			key={organization?.id ?? "no-organization"}
			{...props}
			initialName={organization?.name ?? "My workspace"}
			initialInvitations={invitations?.data?.map((invitation) => invitation.emailAddress)}
			actions={canManage ? makeOnboardingTeamActions(organization) : undefined}
			unavailableReason={
				canManage
					? undefined
					: "An organization admin can rename this workspace and invite teammates. You can continue with setup."
			}
		/>
	)
}
