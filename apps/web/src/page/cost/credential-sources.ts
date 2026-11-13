import {
	ANTHROPIC_COST_KEY_MAX_LENGTH,
	CLOUDFLARE_COST_TOKEN_MAX_LENGTH,
	OPENAI_COST_KEY_MAX_LENGTH,
	OPENROUTER_KEY_MAX_LENGTH,
} from "@maple/domain/http"
import type { Command } from "foldkit"
import type { Resources } from "../../platform/resources"
import {
	RemoveAnthropicCostKey,
	RemoveCloudflareCostToken,
	RemoveOpenAiCostKey,
	RemoveOpenRouterCostKey,
	SaveAnthropicCostKey,
	SaveCloudflareCostToken,
	SaveOpenAiCostKey,
	SaveOpenRouterCostKey,
} from "./command"
import type { Message } from "./message"
import type { CredentialProvider } from "./providers"

type Cmd = Command.Command<Message, never, Resources>

/**
 * Cloudflare's "Create Token" page with the name filled in and one permission ticked, Account >
 * Billing > Read. It starts on all accounts: the reader still picks the one.
 */
const CLOUDFLARE_BILLING_TOKEN_URL =
	"https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22billing%22%2C%22type%22%3A%22read%22%7D%5D&name=Maple%20cost%20source%20%28billing%20read%29&accountId=*&zoneId=all"

/**
 * A cost source added by pasting a credential: everything its dialog steps, its Sources row and
 * its toasts say, and the commands that save and remove it. The form itself is shared.
 */
/** What adding a provider read back three months brings in, as the sync profile serves it. */
const THREE_MONTHS_ADD =
	"Maple reads this month and the last at once, then the two months before, and every day from here on."

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
	remove: Readonly<{ title: string; description: string }>
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
				link: "Create a token with only Billing: Read",
				href: CLOUDFLARE_BILLING_TOKEN_URL,
				after: " in Cloudflare. Under Account Resources pick the one account, set an expiry if you want one, then create it and paste it here. Maple refuses a token it finds can read more than billing, then stores it encrypted.",
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
		},
		save: (apiToken) => SaveCloudflareCostToken({ apiToken }),
		delete: () => RemoveCloudflareCostToken(),
	},
	// Neither vendor offers a key that reads only cost, so the help says what the key can do.
	anthropic: {
		pick: {
			meta: "Daily API spend by model and workspace",
			addedMeta: "Replace its key in the Sources panel",
		},
		field: {
			label: "Admin API key",
			placeholder: "sk-ant-admin...",
			maxLength: ANTHROPIC_COST_KEY_MAX_LENGTH,
			tooLong: "That is too long to be an Anthropic Admin API key.",
			help: {
				before: "Create one under ",
				link: "Admin keys",
				href: "https://platform.claude.com/settings/admin-keys",
				after: " in the Claude Console. Anthropic has no read-only admin key, so this one can also manage your organization: Maple only reads its cost report and name with it, and stores it encrypted. Make one just for Maple so you can revoke it on its own.",
			},
		},
		add: {
			title: "Add Anthropic",
			description: THREE_MONTHS_ADD,
			toast: "Anthropic added",
		},
		replace: {
			title: "Replace the Anthropic key",
			description: "The source and its history stay. Use a key from the same Anthropic organization.",
			label: "Replace key",
			toast: "Anthropic key replaced",
		},
		remove: {
			title: "Remove the Anthropic source?",
			description:
				"Maple deletes the key and stops reading the organization's spend, and its cost leaves this page. Revoke the key in the Claude Console too if nothing else uses it.",
		},
		save: (apiKey) => SaveAnthropicCostKey({ apiKey }),
		delete: () => RemoveAnthropicCostKey(),
	},
	openai: {
		pick: {
			meta: "Daily API spend by model and project",
			addedMeta: "Replace its key in the Sources panel",
		},
		field: {
			label: "Admin API key",
			placeholder: "sk-admin-...",
			maxLength: OPENAI_COST_KEY_MAX_LENGTH,
			tooLong: "That is too long to be an OpenAI Admin API key.",
			help: {
				before: "Create one under ",
				link: "Admin keys",
				href: "https://platform.openai.com/settings/organization/admin-keys",
				after: " in OpenAI. A project API key cannot read spend, and OpenAI has no read-only admin key, so this one can also manage your organization: Maple only reads its costs with it, and stores it encrypted. Make one just for Maple so you can revoke it on its own.",
			},
		},
		add: {
			title: "Add OpenAI",
			description: THREE_MONTHS_ADD,
			toast: "OpenAI added",
		},
		replace: {
			title: "Replace the OpenAI key",
			description: "The source and its history stay. Use a key from the same OpenAI organization.",
			label: "Replace key",
			toast: "OpenAI key replaced",
		},
		remove: {
			title: "Remove the OpenAI source?",
			description:
				"Maple deletes the key and stops reading the organization's spend, and its cost leaves this page. Revoke the key in OpenAI too if nothing else uses it.",
		},
		save: (apiKey) => SaveOpenAiCostKey({ apiKey }),
		delete: () => RemoveOpenAiCostKey(),
	},
} satisfies Record<CredentialProvider, CredentialSource>
