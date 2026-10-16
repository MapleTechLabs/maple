import { Link } from "@tanstack/react-router"

import type { V2GcpConnector } from "@maple/domain/http/v2"
import { DetailRail } from "@maple/ui/components/detail-rail"

import { ExternalLinkIcon } from "@/components/icons"
import { docsUrl } from "@/lib/docs"

import { gcpConsoleProjectPages, gcpConsoleScopePage } from "./inventory"
import { RailLink } from "./gcp-workload-rail"

/** The list page's right rail: what the connections cover, and their pages in the Google Cloud console. */
export function GcpListRail({
	connectors,
	project,
}: {
	connectors: ReadonlyArray<{
		readonly id: string
		readonly scope_type: V2GcpConnector["scope_type"]
		readonly scope_id: string
	}>
	/** The project the page is narrowed to; none for all of them. */
	project: string | undefined
}) {
	// One connected project needs no picking.
	const only =
		connectors.length === 1 && connectors[0].scope_type === "project" ? connectors[0].scope_id : undefined
	const shown = project ?? only
	return (
		<div className="flex flex-col">
			<DetailRail.Group label="Connected">
				{connectors.map((connector) => (
					<RailLink key={connector.id}>
						<ConsoleLink href={gcpConsoleScopePage(connector)}>
							{`${connector.scope_type} ${connector.scope_id}`}
						</ConsoleLink>
					</RailLink>
				))}
			</DetailRail.Group>
			<DetailRail.Group label="Google Cloud console">
				{shown === undefined ? (
					<p className="text-2xs leading-relaxed text-muted-foreground">
						Pick a project to open its pages in Google Cloud.
					</p>
				) : (
					<>
						<p className="font-mono text-2xs text-muted-foreground">project {shown}</p>
						{gcpConsoleProjectPages(shown).map((page) => (
							<RailLink key={page.label}>
								<ConsoleLink href={page.href}>{page.label}</ConsoleLink>
							</RailLink>
						))}
					</>
				)}
			</DetailRail.Group>
			<DetailRail.Group label="Also">
				<RailLink>
					<Link to="/integrations" search={{ integration: "gcp" }}>
						Integration settings
					</Link>
				</RailLink>
				<RailLink>
					<ConsoleLink href={docsUrl("gcp")}>Docs</ConsoleLink>
				</RailLink>
			</DetailRail.Group>
		</div>
	)
}

function ConsoleLink({ href, children }: { href: string; children: string }) {
	return (
		<a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
			{children}
			<ExternalLinkIcon size={12} />
		</a>
	)
}
