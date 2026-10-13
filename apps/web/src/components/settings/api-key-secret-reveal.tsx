import { CopyableField } from "@maple/ui/components/ui/copyable-field"

interface ApiKeySecretRevealProps {
	secret: string
}

/**
 * Read-only reveal of a freshly minted API key secret, shown once at create/roll
 * time. Masked by default behind an eye toggle; copy always copies the full secret.
 * Shared by the create and roll dialogs so the "copy it now" UX stays identical.
 */
export function ApiKeySecretReveal({ secret }: ApiKeySecretRevealProps) {
	return (
		<div className="space-y-3">
			<CopyableField value={secret} copyLabel="API key" masked />
			<p className="text-muted-foreground text-xs">
				Store this key in a secure location. It will not be shown again.
			</p>
		</div>
	)
}
