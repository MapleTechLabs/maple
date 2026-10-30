import type { AccountTone, CloudflareAccount } from "../../../../components/infra/cloudflare/accounts"
import { formatPercentColumn } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heroFieldChipClass, heroFieldChipParts } from "../../../infra/kit/hero-chip"
import type * as Menu from "../../../../ui/menu"
import * as MenuView from "../../../../ui/menu-view"
import { statusDot } from "../../../../ui/status-dot"
import { Message } from "./model"
import { ALL_ACCOUNTS, MANAGE_ACCOUNTS } from "./update"

// Multi-account Cloudflare: these only render with two or more accounts; a single-account org keeps
// a plain chip.

type H = HtmlBuilder<Message>

const TONE_TEXT = {
	ok: "text-muted-foreground",
	warn: "text-severity-warn",
	crit: "text-severity-error",
} as const satisfies Record<AccountTone, string>

/**
 * `CloudflareAccountMenu`. TODO(menu): each account wants a health dot and a second line
 * (zones, health); the menu's radio entries are text, so both ride in the label.
 */
export const accountMenu = (
	h: H,
	menu: Menu.Model,
	accounts: ReadonlyArray<CloudflareAccount>,
	value: string | undefined,
): Html => {
	const selected = accounts.find((account) => account.accountId === value)
	return h.submodel({
		slotId: "cloudflare-account-menu",
		model: menu,
		view: MenuView.view,
		toParentMessage: (message: Menu.Message) => Message.GotAccountMenuMessage({ message }),
		viewInputs: {
			entries: [
				{
					_tag: "RadioGroup",
					items: [{ value: ALL_ACCOUNTS, label: "All accounts", isChecked: value === undefined }],
				},
				{ _tag: "Separator" },
				{
					_tag: "RadioGroup",
					items: accounts.map((account) => ({
						value: account.accountId,
						label: `${account.name} · ${account.zones.length} zones · ${account.health.message}`,
						isChecked: account.accountId === value,
					})),
				},
				{ _tag: "Separator" },
				{ _tag: "Item", value: MANAGE_ACCOUNTS, label: "Manage accounts" },
			],
			className: "min-w-80",
			align: "start",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						h.button(
							[
								h.Type("button"),
								h.Class(heroFieldChipClass(true)),
								h.DataAttribute("slot", "badge"),
								...trigger,
							],
							heroFieldChipParts(h, {
								label: selected === undefined ? "accounts" : "account",
								value: selected === undefined ? `All ${accounts.length}` : selected.name,
								isPicker: true,
							}),
						),
					),
				),
		},
	})
}

/** `CloudflareAccountsStrip`: one cell per account, a scope like the band's cells. */
export const accountsStrip = (
	h: H,
	accounts: ReadonlyArray<CloudflareAccount>,
	share: ReadonlyMap<string, number>,
	counts: ReadonlyMap<string, { zones: number; workers: number }>,
): Html =>
	h.div(
		[h.Class("flex flex-col overflow-hidden rounded-md border md:flex-row")],
		accounts.map((account) => {
			const fraction = share.get(account.accountId) ?? 0
			const count = counts.get(account.accountId)
			return h.button(
				[
					h.Key(account.accountId),
					h.Type("button"),
					h.OnClick(Message.ClickedAccount({ accountId: account.accountId })),
					h.Class(
						"flex flex-1 flex-col gap-2 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-surface-sunken md:border-b-0 md:border-l md:first:border-l-0",
					),
				],
				[
					h.span(
						[h.Class("flex items-center gap-2")],
						[
							statusDot(h, { tone: account.health.tone }),
							h.span([h.Class("truncate text-xs font-medium text-foreground")], [account.name]),
							h.span(
								[h.Class("ml-auto font-mono text-2xs tabular-nums text-foreground")],
								[formatPercentColumn(fraction)],
							),
						],
					),
					h.span(
						[h.Class("block h-1 w-full overflow-hidden rounded-full bg-muted")],
						[
							h.span([
								h.Class("block h-full rounded-full bg-foreground-subtle"),
								h.Style({ width: `${Math.max(fraction * 100, fraction > 0 ? 1.5 : 0)}%` }),
							]),
						],
					),
					h.span(
						[h.Class(cn("truncate font-mono text-3xs", TONE_TEXT[account.health.tone]))],
						[
							account.health.tone === "ok" && count !== undefined
								? `${count.zones} zones · ${count.workers} Workers · ${account.health.message}`
								: account.health.message,
						],
					),
				],
			)
		}),
	)

/** `CloudflareAccountHealthLine`: scoped to one account, and only when something is wrong. */
export const accountHealthLine = (h: H, account: CloudflareAccount): Html | null =>
	account.health.tone === "ok"
		? null
		: h.div(
				[
					h.Class(
						cn(
							"flex items-center gap-2 rounded-md px-3 py-2 text-xs",
							account.health.tone === "crit" ? "bg-severity-error/10" : "bg-severity-warn/10",
						),
					),
				],
				[
					statusDot(h, { tone: account.health.tone }),
					h.span(
						[h.Class("text-foreground")],
						[
							`${account.name}: ${account.health.message}. Its numbers stop at the last sync; the gap is missing data.`,
						],
					),
				],
			)
