// Shared loading / empty / error placeholders so every view reads the same way,
// built on the @maple/ui `Empty` compound + `Skeleton`.

import type { ReactNode } from "react"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { CircleWarningIcon, ConnectionIcon } from "@maple/ui/components/icons"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { DEFAULT_LOCAL_PORT, isHostedUi, LOCAL_OTLP_ENDPOINT, localServerPort } from "../lib/constants"
import { DOCS_CLI_REFERENCE, DOCS_LOCAL_MODE_INSTALL, INSTALL_METHODS } from "../lib/links"

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: ReactNode }) {
	return (
		<Empty className="h-full">
			{icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				{hint ? <EmptyDescription>{hint}</EmptyDescription> : null}
			</EmptyHeader>
		</Empty>
	)
}

export function ErrorState({
	label,
	error,
	onRetry,
}: {
	label: string
	error: unknown
	onRetry?: () => void
}) {
	const message = error instanceof Error ? error.message : String(error)
	return (
		<Empty className="h-full">
			<EmptyMedia variant="icon">
				<CircleWarningIcon className="text-destructive" />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>Couldn’t load {label}</EmptyTitle>
				<EmptyDescription className="font-mono text-xs break-all">{message}</EmptyDescription>
			</EmptyHeader>
			{onRetry ? (
				<EmptyContent>
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
				</EmptyContent>
			) : null}
		</Empty>
	)
}

/** The command that starts a server on the port this page expects. */
export function startCommand(port: string): string {
	return port === DEFAULT_LOCAL_PORT ? "maple start" : `maple start --port ${port}`
}

/**
 * Shown in place of the views when nothing answers on the expected port. The
 * status poll keeps running, so it recovers on its own; "Try again" probes now.
 */
export function DisconnectedState({ onRetry }: { onRetry: () => void }) {
	const hosted = isHostedUi()
	const port = localServerPort()
	return (
		<Empty className="h-full overflow-auto">
			<EmptyMedia variant="icon">
				<ConnectionIcon className="text-muted-foreground" />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>Can’t reach Maple Local</EmptyTitle>
				<EmptyDescription>
					Nothing is answering on port {port}. Start the local server and this page connects on its
					own.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="w-full max-w-md items-stretch gap-3 text-left">
				<InstallCommands />

				<Separator />

				<span className="text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
					Already installed?
				</span>
				<CopyableField label="Start Maple" value={startCommand(port)} />
				<CopyableField label="Expecting" value={LOCAL_OTLP_ENDPOINT} />
				{hosted ? (
					<p className="text-left text-xs text-muted-foreground">
						This page runs on local.maple.dev and talks to your machine directly, so your browser
						may ask to allow access to devices on your local network: allow it. Running on another
						port? Add <code className="rounded bg-muted px-1">?port=&lt;n&gt;</code> to the URL.
						To skip the prompt, run{" "}
						<code className="rounded bg-muted px-1">maple start --offline</code> and open the URL
						it prints.
					</p>
				) : null}
				<div className="flex items-center justify-between gap-2">
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
					<span className="flex items-center gap-2 text-xs text-muted-foreground">
						<DocsLink href={DOCS_LOCAL_MODE_INSTALL}>Local mode</DocsLink>
						<span aria-hidden="true">·</span>
						<DocsLink href={DOCS_CLI_REFERENCE}>CLI reference</DocsLink>
					</span>
				</div>
			</EmptyContent>
		</Empty>
	)
}

/** The server answered but turned this page away (403 origin rejected, 400, ...). */
export function RejectedState({
	rejection,
	onRetry,
}: {
	rejection: { status: number; detail: string }
	onRetry: () => void
}) {
	const originRejected = rejection.status === 403
	return (
		<Empty className="h-full">
			<EmptyMedia variant="icon">
				<CircleWarningIcon className="text-destructive" />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>Maple Local refused this page ({rejection.status})</EmptyTitle>
				<EmptyDescription>
					{originRejected
						? "The server only accepts the dashboard it was started for. Open the URL that maple start printed, or restart it without a custom UI origin."
						: "The server rejected the status request."}
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="w-full max-w-md items-stretch gap-3">
				{rejection.detail ? (
					<pre className="whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-3 py-2 text-left font-mono text-[11px]">
						{rejection.detail}
					</pre>
				) : null}
				<Button variant="outline" size="sm" className="self-center" onClick={onRetry}>
					Try again
				</Button>
			</EmptyContent>
		</Empty>
	)
}

/**
 * Homebrew / install-script commands for the `maple` binary; the disconnected
 * screen is where the user may not have the CLI at all.
 */
function InstallCommands() {
	return (
		<Tabs defaultValue={INSTALL_METHODS[0].id} className="gap-2">
			<TabsList variant="underline" className="justify-start">
				{INSTALL_METHODS.map((method) => (
					<TabsTrigger key={method.id} value={method.id}>
						{method.label}
					</TabsTrigger>
				))}
			</TabsList>
			{INSTALL_METHODS.map((method) => (
				<TabsContent key={method.id} value={method.id} className="mt-0">
					<CopyableField label="" copyLabel="Command" value={method.command} />
				</TabsContent>
			))}
		</Tabs>
	)
}

function DocsLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="underline underline-offset-2 hover:no-underline"
		>
			{children}
		</a>
	)
}

/**
 * Content-shaped loading placeholder: `table` for row lists, `card` for the
 * card stacks.
 */
export function ListSkeleton({ rows = 8, variant = "table" }: { rows?: number; variant?: "table" | "card" }) {
	return (
		<div className="space-y-2 p-4">
			{Array.from({ length: rows }).map((_, i) => (
				<Skeleton
					key={i}
					className={variant === "card" ? "h-[68px] w-full rounded-xl" : "h-10 w-full rounded-md"}
				/>
			))}
		</div>
	)
}
