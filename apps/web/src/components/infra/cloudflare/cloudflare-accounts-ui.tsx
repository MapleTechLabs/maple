// Multi-account Cloudflare: one OAuth grant can cover several accounts. These only render with two
// or more; a single-account org keeps a plain chip and never sees an "All accounts" anywhere.

import { Link } from "@tanstack/react-router"

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"
import { formatPercent } from "@maple/ui/lib/format"

import { ChevronDownIcon } from "@/components/icons"
import type { AccountTone, CloudflareAccount } from "./accounts"

const TONE_DOT = {
	ok: "bg-severity-info",
	warn: "bg-severity-warn",
	crit: "bg-severity-error",
} satisfies Record<AccountTone, string>
const TONE_TEXT = {
	ok: "text-muted-foreground",
	warn: "text-severity-warn",
	crit: "text-severity-error",
} satisfies Record<AccountTone, string>

const ALL = "__all__"

export function CloudflareAccountMenu({
	accounts,
	value,
	onChange,
}: {
	accounts: ReadonlyArray<CloudflareAccount>
	/** Account id, or undefined for all accounts. */
	value: string | undefined
	onChange: (accountId: string | undefined) => void
}) {
	const selected = accounts.find((account) => account.accountId === value)
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Badge variant="meta" size="xs" mono render={<button type="button" />} />}
				className="cursor-pointer gap-1 font-normal text-muted-foreground transition-colors hover:text-foreground"
			>
				{selected === undefined ? "accounts" : "account"}
				<span className="text-foreground">
					{selected === undefined ? `All ${accounts.length}` : selected.name}
				</span>
				<ChevronDownIcon className="size-3 opacity-60" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-80">
				<DropdownMenuRadioGroup
					value={value ?? ALL}
					onValueChange={(next) => onChange(next === ALL ? undefined : String(next))}
				>
					<DropdownMenuRadioItem value={ALL} closeOnClick>
						All accounts
					</DropdownMenuRadioItem>
					<DropdownMenuSeparator />
					{accounts.map((account) => (
						<DropdownMenuRadioItem key={account.accountId} value={account.accountId} closeOnClick>
							<span className="flex items-start gap-2">
								<span
									aria-hidden
									className={cn(
										"mt-1.5 size-1.5 shrink-0 rounded-full",
										TONE_DOT[account.health.tone],
									)}
								/>
								<span className="flex flex-col">
									<span>{account.name}</span>
									<span className={cn("text-3xs", TONE_TEXT[account.health.tone])}>
										{account.zones.length} zones · {account.health.message}
									</span>
								</span>
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem render={<Link to="/integrations" search={{ integration: "cloudflare" }} />}>
					Manage accounts
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/**
 * One cell per account: its share of the view's traffic, its size, and its own sync health. A cell
 * is a scope, like the band's cells: click to see only that account.
 */
export function CloudflareAccountsStrip({
	accounts,
	share,
	counts,
	onSelect,
}: {
	accounts: ReadonlyArray<CloudflareAccount>
	/** Share of the current view's traffic per account id, 0-1. */
	share: ReadonlyMap<string, number>
	counts: ReadonlyMap<string, { zones: number; workers: number }>
	onSelect: (accountId: string) => void
}) {
	return (
		<div className="flex flex-col overflow-hidden rounded-md border md:flex-row">
			{accounts.map((account) => {
				const fraction = share.get(account.accountId) ?? 0
				const count = counts.get(account.accountId)
				return (
					<button
						key={account.accountId}
						type="button"
						onClick={() => onSelect(account.accountId)}
						className="flex flex-1 flex-col gap-2 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/40 md:border-b-0 md:border-l md:first:border-l-0"
					>
						<span className="flex items-center gap-2">
							<span
								aria-hidden
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									TONE_DOT[account.health.tone],
								)}
							/>
							<span className="truncate text-xs font-medium text-foreground">
								{account.name}
							</span>
							<span className="ml-auto font-mono text-2xs tabular-nums text-foreground">
								{formatPercent(fraction)}
							</span>
						</span>
						<span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
							<span
								className="block h-full rounded-full bg-muted-foreground/60"
								style={{ width: `${Math.max(fraction * 100, fraction > 0 ? 1.5 : 0)}%` }}
							/>
						</span>
						<span className={cn("truncate font-mono text-3xs", TONE_TEXT[account.health.tone])}>
							{account.health.tone === "ok" && count !== undefined
								? `${count.zones} zones · ${count.workers} Workers · ${account.health.message}`
								: account.health.message}
						</span>
					</button>
				)
			})}
		</div>
	)
}

/** Scoped to one account, the strip collapses to this line, and only when something is wrong. */
export function CloudflareAccountHealthLine({ account }: { account: CloudflareAccount }) {
	if (account.health.tone === "ok") return null
	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded-md px-3 py-2 text-xs",
				account.health.tone === "crit" ? "bg-severity-error/10" : "bg-severity-warn/10",
			)}
		>
			<span
				aria-hidden
				className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[account.health.tone])}
			/>
			<span className="text-foreground">
				{account.name}: {account.health.message}. Its numbers stop at the last sync; the gap is
				missing data.
			</span>
		</div>
	)
}
