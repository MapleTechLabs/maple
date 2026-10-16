import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import type { ExternalAccount, OAuthStrategy } from "@/components/account/account-types"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { GithubIcon, GoogleIcon, type IconComponent } from "@/components/icons"
import { settleClerk, toastAccountError } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"

interface Provider {
	strategy: OAuthStrategy
	/** The `provider` value Clerk stamps on an `ExternalAccount`. */
	id: string
	label: string
	icon: IconComponent
}

const PROVIDERS: ReadonlyArray<Provider> = [
	{ strategy: "oauth_google", id: "google", label: "Google", icon: GoogleIcon },
	{ strategy: "oauth_github", id: "github", label: "GitHub", icon: GithubIcon },
]

export function ConnectedAccountsSection() {
	const { user, isLoaded } = useUser()

	const [busyProvider, setBusyProvider] = useState<string | null>(null)
	const [pendingRemoval, setPendingRemoval] = useState<{
		account: ExternalAccount
		label: string
	} | null>(null)

	const destroyExternalAccount = useReverification((account: ExternalAccount) => account.destroy())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	/**
	 * Linking cannot happen in a dialog: `createExternalAccount` hands back a redirect URL that
	 * the browser has to visit so the provider can run its own consent screen. Coming back to
	 * `/account?tab=connections` is what makes the new row appear.
	 */
	/** Sends the browser to the provider's consent screen, or clears the busy row when there is none. */
	function followRedirect(provider: Provider, redirect: URL | string | null | undefined) {
		if (!redirect) {
			toastManager.add({ title: `${provider.label} did not return a sign-in URL`, type: "error" })
			setBusyProvider(null)
			return
		}
		window.location.href = redirect.toString()
	}

	function handleConnect(provider: Provider) {
		if (!user) return
		setBusyProvider(provider.id)
		return user
			.createExternalAccount({ strategy: provider.strategy, redirectUrl: "/account?tab=connections" })
			.then(
				(account) => followRedirect(provider, account.verification?.externalVerificationRedirectURL),
				(err: unknown) => {
					toastAccountError(err, `Failed to connect ${provider.label}`)
					setBusyProvider(null)
				},
			)
	}

	/** An account that came back unverified needs the provider round trip run again. */
	function handleRetry(provider: Provider, account: ExternalAccount) {
		setBusyProvider(provider.id)
		return account.reauthorize({ redirectUrl: "/account?tab=connections" }).then(
			(reauthorized) =>
				followRedirect(provider, reauthorized.verification?.externalVerificationRedirectURL),
			(err: unknown) => {
				toastAccountError(err, `Failed to reconnect ${provider.label}`)
				setBusyProvider(null)
			},
		)
	}

	async function handleDisconnect() {
		if (!pendingRemoval) return
		const { account, label } = pendingRemoval
		setBusyProvider(account.provider)
		const ok = await settleClerk(destroyExternalAccount(account), {
			success: `${label} disconnected`,
			error: `Failed to disconnect ${label}`,
		})
		if (ok) setPendingRemoval(null)
		setBusyProvider(null)
	}

	return (
		<SettingsSections>
			<SettingsSection
				title="Connected accounts"
				description="Sign in to Maple with a provider you already use. Disconnecting one removes it as a sign-in method."
				padded={false}
			>
				<div className="divide-y">
					{PROVIDERS.map((provider) => {
						const account = user.externalAccounts.find((a) => a.provider === provider.id)
						const isVerified = account?.verification?.status === "verified"
						const isBusy = busyProvider === provider.id

						return (
							<SettingRow
								key={provider.id}
								className="p-4"
								icon={
									<div className="text-muted-foreground">
										<provider.icon size={18} />
									</div>
								}
								label={
									<span className="flex items-center gap-1.5">
										{provider.label}
										{account && !isVerified && (
											<Badge variant="outline" className="text-muted-foreground">
												Incomplete
											</Badge>
										)}
									</span>
								}
								description={
									<span className="block truncate">
										{account
											? account.emailAddress || account.username || "Connected"
											: `Connect your ${provider.label} account`}
									</span>
								}
								control={
									account ? (
										<>
											{!isVerified && (
												<Button
													variant="outline"
													size="sm"
													disabled={isBusy}
													onClick={() => void handleRetry(provider, account)}
												>
													Retry
												</Button>
											)}
											<Button
												variant="ghost"
												size="sm"
												disabled={isBusy}
												onClick={() =>
													setPendingRemoval({ account, label: provider.label })
												}
											>
												Disconnect
											</Button>
										</>
									) : (
										<Button
											variant="outline"
											size="sm"
											loading={isBusy}
											onClick={() => void handleConnect(provider)}
										>
											Connect
										</Button>
									)
								}
							/>
						)
					})}
				</div>
			</SettingsSection>

			<ConfirmDialog
				open={pendingRemoval !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRemoval(null)
				}}
				title={`Disconnect ${pendingRemoval?.label}?`}
				description={`You will no longer be able to sign in to Maple with ${pendingRemoval?.label}. Make sure you still have a password, a passkey or another connected account first.`}
				confirmLabel="Disconnect"
				pending={busyProvider !== null}
				onConfirm={() => void handleDisconnect()}
			/>
		</SettingsSections>
	)
}
