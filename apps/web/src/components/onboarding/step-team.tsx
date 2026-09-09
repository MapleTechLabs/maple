import { useRef, useState } from "react"
import { Cause, Effect, Exit, Option } from "effect"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { ArrowLeftIcon, CircleCheckIcon } from "@/components/icons"
import type { OnboardingTeamActions, OnboardingTeamError } from "./team-actions"

export function StepTeam({
	initialName,
	initialInvitations = [],
	actions,
	unavailableReason,
	onContinue,
	onBack,
}: {
	initialName: string
	initialInvitations?: readonly string[]
	actions?: OnboardingTeamActions
	unavailableReason?: string
	onContinue: () => void
	onBack: () => void
}) {
	const [name, setName] = useState(initialName)
	const [savedName, setSavedName] = useState(initialName)
	const [email, setEmail] = useState("")
	const [invited, setInvited] = useState<readonly string[]>(initialInvitations)
	const [pending, setPending] = useState<"rename" | "invite" | null>(null)
	const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null)
	const inFlight = useRef(false)
	const emailAlreadyInvited = invited.some(
		(address) => address.toLowerCase() === email.trim().toLowerCase(),
	)
	const dirtyName = name.trim() !== savedName

	function run(
		operation: "rename" | "invite",
		effect: Effect.Effect<void, OnboardingTeamError>,
		onSuccess: () => void,
	) {
		if (inFlight.current) return
		inFlight.current = true
		setPending(operation)
		setFeedback(null)
		void Effect.runPromiseExit(effect).then((result) => {
			inFlight.current = false
			setPending(null)
			if (Exit.isSuccess(result)) {
				onSuccess()
			} else {
				const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause))
				setFeedback({
					message: failure?.message ?? "Something went wrong. Please try again.",
					error: true,
				})
			}
		})
	}

	return (
		<div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
			<div className="w-full max-w-xl space-y-8">
				<div className="space-y-3 text-center">
					<h1 className="text-3xl font-semibold tracking-tight">Bring your team</h1>
					<p className="text-sm leading-relaxed text-muted-foreground">
						A shared place for the people behind your services.
						<br />
						Flying solo? You can invite teammates later.
					</p>
				</div>
				{unavailableReason && <p className="text-sm text-muted-foreground">{unavailableReason}</p>}
				<form
					onSubmit={(event) => {
						event.preventDefault()
						if (!actions || !name.trim() || !dirtyName) return
						const nextName = name.trim()
						run("rename", actions.rename(nextName), () => {
							setSavedName(nextName)
							setName(nextName)
							setFeedback({
								message: "Workspace name saved. Make yourself at home.",
								error: false,
							})
						})
					}}
					className="space-y-3"
				>
					<Label htmlFor="onboarding-workspace-name">Workspace name</Label>
					<div className="flex flex-wrap gap-2">
						<Input
							id="onboarding-workspace-name"
							type="text"
							autoComplete="organization"
							value={name}
							onChange={(event) => setName(event.target.value)}
							required
							maxLength={256}
							disabled={!actions || pending !== null}
							className="min-w-40 flex-1"
						/>
						<Button
							type="submit"
							variant="outline"
							disabled={!actions || pending !== null || !name.trim() || !dirtyName}
						>
							{pending === "rename" ? "Saving…" : "Save name"}
						</Button>
					</div>
				</form>
				<form
					onSubmit={(event) => {
						event.preventDefault()
						if (!actions || !email.trim() || emailAlreadyInvited) return
						const address = email.trim()
						run("invite", actions.invite(address), () => {
							setInvited((previous) => [...previous, address])
							setEmail("")
							setFeedback({ message: `Invitation sent to ${address}.`, error: false })
						})
					}}
					className="space-y-3 border-t pt-6"
				>
					<Label htmlFor="onboarding-teammate-email">
						Invite a teammate{" "}
						<span className="font-normal text-muted-foreground">(optional)</span>
					</Label>
					<div className="flex flex-wrap gap-2">
						<Input
							id="onboarding-teammate-email"
							type="email"
							autoComplete="email"
							placeholder="teammate@company.com"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							required
							disabled={!actions || pending !== null}
							aria-describedby="onboarding-invite-help"
							className="min-w-40 flex-1"
						/>
						<Button
							type="submit"
							variant="outline"
							disabled={!actions || pending !== null || !email.trim() || emailAlreadyInvited}
						>
							{pending === "invite" ? "Sending…" : "Send invitation"}
						</Button>
					</div>
					<p id="onboarding-invite-help" className="text-xs leading-relaxed text-muted-foreground">
						{emailAlreadyInvited
							? "This teammate already has a pending invitation."
							: "They’ll receive an email invitation to join this workspace as a member."}
					</p>
				</form>
				{invited.length > 0 && (
					<ul aria-label="Pending invitations" className="space-y-2">
						{invited.map((address) => (
							<li key={address} className="flex items-center gap-2 text-xs">
								<CircleCheckIcon size={14} className="shrink-0 text-primary" />
								<span className="min-w-0 break-all">{address}</span>
								<span className="ml-auto text-muted-foreground">Invited</span>
							</li>
						))}
					</ul>
				)}
				<div aria-live="polite" aria-atomic="true" className="min-h-5 text-xs">
					<p className={feedback?.error ? "text-destructive" : "text-muted-foreground"}>
						{feedback?.message}
					</p>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<Button variant="ghost" disabled={pending !== null} onClick={onBack}>
						<ArrowLeftIcon size={14} />
						Back
					</Button>
					<Button size="lg" disabled={pending !== null} onClick={onContinue}>
						{dirtyName || email.trim() ? "Skip for now" : "Continue to plans"}
					</Button>
				</div>
			</div>
		</div>
	)
}
