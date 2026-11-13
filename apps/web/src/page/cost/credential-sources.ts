import { CLOUDFLARE_COST_TOKEN_MAX_LENGTH, OPENROUTER_KEY_MAX_LENGTH } from "@maple/domain/http"
import type { Command } from "foldkit"
import type { Resources } from "../../platform/resources"
import {
	RemoveCloudflareCostToken,
	RemoveOpenRouterCostKey,
	SaveCloudflareCostToken,
	SaveOpenRouterCostKey,
} from "./command"
import type { Message } from "./message"
import type { CredentialProvider } from "./providers"

type Cmd = Command.Command<Message, never, Resources>

/**
 * A cost source added by pasting a credential: everything its dialog steps, its Sources row and
 * its toasts say, and the commands that save and remove it. The form itself is shared.
 */
export type CredentialSource = Readonly<{
	/** The line under the provider's name in the list, and once its source exists. */
	pick: Readonly<{ meta: string; addedMeta: string }>
	field: Readonly<{
		label: string
		placeholder: string
		maxLength: number
		/** Shown when the text is longer than `maxLength`, which the request would refuse to carry. */
		tooLong: string
		/** The help under the field: `before`, a link to where the credential is made, then `after`. */
		help: Readonly<{ before: string; link: string; href: string; after: string }>
	}>
	add: Readonly<{ title: string; description: string; toast: string }>
	replace: Readonly<{
		title: string
		description: string
		/** The Sources row's action and the form's submit. */
		label: string
		toast: string
	}>
	remove: Readonly<{ title: string; description: string; toast: string }>
	save: (secret: string) => Cmd
	delete: () => Cmd
}>

export const CREDENTIAL_SOURCES = {
	openrouter: {
		pick: {
			meta: "Daily spend by model and serving provider",
			addedMeta: "Replace its key in the Sources panel",
		},
		field: {
			label: "Management key",
			placeholder: "sk-or-v1-...",
			maxLength: OPENROUTER_KEY_MAX_LENGTH,
			tooLong: "That is too long to be an OpenRouter key.",
			help: {
				before: "Create one under ",
				link: "Management keys",
				href: "https://openrouter.ai/settings/management-keys",
				after: " in OpenRouter. A regular API key cannot read spend. Maple checks the key with OpenRouter, then stores it encrypted.",
			},
		},
		add: {
			title: "Add OpenRouter",
			description: "Maple reads the last four weeks at once, then every day from here on.",
			toast: "OpenRouter added",
		},
		replace: {
			title: "Replace the OpenRouter key",
			description: "The source and its history stay. Use a key from the same OpenRouter account.",
			label: "Replace key",
			toast: "OpenRouter key replaced",
		},
		remove: {
			title: "Remove the OpenRouter source?",
			description:
				"Maple deletes the key and stops reading the account's spend, and its cost leaves this page. Adding OpenRouter again brings back the last four weeks only.",
			toast: "OpenRouter removed",
		},
		save: (apiKey) => SaveOpenRouterCostKey({ apiKey }),
		delete: () => RemoveOpenRouterCostKey(),
	},
	cloudflare: {
		pick: {
			meta: "Daily charges by product, plus plan fees",
			addedMeta: "Replace its token in the Sources panel",
		},
		field: {
			label: "API token",
			placeholder: "Cloudflare API token",
			maxLength: CLOUDFLARE_COST_TOKEN_MAX_LENGTH,
			tooLong: "That is too long to be a Cloudflare API token.",
			help: {
				before: "",
				link: "Create a custom token",
				href: "https://dash.cloudflare.com/profile/api-tokens",
				after: " with the Billing: Read permission on one account. Maple checks the token with Cloudflare, then stores it encrypted.",
			},
		},
		add: {
			title: "Add Cloudflare",
			description:
				"Maple reads this month and the last at once, then older months back to a year, and every day from here on.",
			toast: "Cloudflare added",
		},
		replace: {
			title: "Replace the Cloudflare token",
			description: "The source and its history stay. Use a token for the same Cloudflare account.",
			label: "Replace token",
			toast: "Cloudflare token replaced",
		},
		remove: {
			title: "Remove the Cloudflare source?",
			description:
				"Maple deletes the token and stops reading the account's charges, and its cost leaves this page. Adding Cloudflare again reads the last year again.",
			toast: "Cloudflare removed",
		},
		save: (apiToken) => SaveCloudflareCostToken({ apiToken }),
		delete: () => RemoveCloudflareCostToken(),
	},
} satisfies Record<CredentialProvider, CredentialSource>
