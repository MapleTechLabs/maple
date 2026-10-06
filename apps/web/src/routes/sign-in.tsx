import { createFileRoute } from "@tanstack/react-router"
import { SignIn } from "@clerk/clerk-react"

import { FormEvent, useState } from "react"
import { Schema } from "effect"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { setSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth"
import { AccountLayout } from "@/components/layout/account-layout"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { clerkAuthCardAppearance } from "@/lib/clerk-appearance"
import { tracedFetch } from "@/lib/services/common/telemetry"

const SignInSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/sign-in")({
	component: SignInPage,
	validateSearch: Schema.toStandardSchemaV1(SignInSearch),
})

export const redirectToDashboard = () => {
	const params = new URLSearchParams(window.location.search)
	// Only same-origin relative paths are allowed. An absolute URL or
	// protocol-relative `//attacker/` would let an attacker exfiltrate the
	// just-stored session token by phishing through a sign-in link.
	const redirectUrl = validateInternalRedirect(params.get("redirect_url")) ?? "/"
	window.location.assign(redirectUrl)
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message
	}

	return "Unable to sign in"
}

async function loginSelfHosted(password: string) {
	const response = await tracedFetch("maple-api", `${apiBaseUrl}/api/auth/login`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({ password }),
	})

	if (!response.ok) {
		const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
		throw new Error(errorBody?.message ?? "Invalid root password")
	}

	return (await response.json()) as { token: string }
}

export function SelfHostedSignInPage() {
	const [password, setPassword] = useState("")
	const [errorMessage, setErrorMessage] = useState<string | null>(null)

	const [submit, isSubmitting] = useAsyncAction(async () => {
		setErrorMessage(null)
		await loginSelfHosted(password)
			.then((result) => {
				setSelfHostedSessionToken(result.token)
				redirectToDashboard()
			})
			.catch((error: unknown) => setErrorMessage(getErrorMessage(error)))
	})

	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!isSubmitting) void submit()
	}

	return (
		<AccountLayout>
			<div className="space-y-8">
				<div className="space-y-2">
					<h1 className="font-display font-[650] text-[30px] leading-[1.1] tracking-[-0.03em]">
						Sign in to Maple
					</h1>
					<p className="font-display text-muted-foreground text-sm leading-relaxed">
						This deployment is self-hosted. Enter the root password to continue.
					</p>
				</div>
				<form className="space-y-6" onSubmit={onSubmit}>
					{/* Label and field are one group: the gap between them stays tighter
					 * than the gap to the next control, or the pairing stops reading. */}
					<div className="space-y-2">
						<label
							htmlFor="root-password"
							className="block font-mono font-medium text-xs tracking-[0.02em]"
						>
							Root password
						</label>
						<Input
							id="root-password"
							aria-invalid={Boolean(errorMessage)}
							aria-describedby={errorMessage ? "login-error" : undefined}
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete="current-password"
							disabled={isSubmitting}
							required
						/>
						{errorMessage ? (
							<p id="login-error" role="alert" className="font-mono text-destructive text-xs">
								{errorMessage}
							</p>
						) : null}
					</div>
					<Button type="submit" className="w-full" loading={isSubmitting}>
						Sign in
					</Button>
				</form>
			</div>
		</AccountLayout>
	)
}

function SignInPage() {
	const { redirect_url } = Route.useSearch()
	// Clerk's <SignIn> defaults its post-sign-in redirect to "/", which would
	// discard the guard-preserved redirect_url (e.g. after a hard reload on a
	// deep link bounced through /sign-in while the session was still settling).
	const target = validateInternalRedirect(redirect_url ?? null)

	if (isClerkAuthEnabled) {
		return (
			<AccountLayout>
				<SignIn appearance={clerkAuthCardAppearance} forceRedirectUrl={target ?? undefined} />
			</AccountLayout>
		)
	}

	return <SelfHostedSignInPage />
}

export { loginSelfHosted }
