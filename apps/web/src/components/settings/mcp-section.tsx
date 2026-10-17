import { useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import { McpToolsList } from "@/components/mcp/mcp-tools-list"
import { CodeBlock } from "@/components/quick-start/code-block"
import { CreateApiKeyDialog } from "@/components/settings/create-api-key-dialog"
import {
	claudeCodeCommand,
	isMcpClient,
	MCP_CLIENTS,
	mcpClientConfig,
	type McpClient,
} from "@/components/settings/mcp-client-config"
import { McpConnectedClientsSection } from "@/components/settings/mcp-connected-clients"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { mcpUrl } from "@/lib/services/common/mcp-url"

const mcpEndpoint = `${mcpUrl}/mcp`

const keysLinkClass = "text-foreground underline underline-offset-2 hover:no-underline"

/** Snippets carry the bearer secret once a key is created; the dashboard records itself with rrweb. */
function Snippet({ hint, code, language }: { hint: ReactNode; code: string; language: string }) {
	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground">{hint}</p>
			<CodeBlock code={code} language={language} className={REPLAY_BLOCK_CLASS} />
		</div>
	)
}

function ClientSnippets({ client, apiKey }: { client: McpClient; apiKey: string | undefined }) {
	const json = mcpClientConfig(client, mcpEndpoint, apiKey)
	switch (client) {
		case "claude-code":
			return (
				<div className="space-y-4">
					<Snippet
						hint="Run in your terminal"
						code={claudeCodeCommand(mcpEndpoint, apiKey)}
						language="bash"
					/>
					<Snippet
						hint={
							<>
								Or add to <InlineCode>.mcp.json</InlineCode> in your project
							</>
						}
						code={json}
						language="json"
					/>
				</div>
			)
		case "cursor":
			return (
				<Snippet
					hint={
						<>
							Add to <InlineCode>.cursor/mcp.json</InlineCode> in your project, or{" "}
							<InlineCode>~/.cursor/mcp.json</InlineCode> for every project
						</>
					}
					code={json}
					language="json"
				/>
			)
		case "windsurf":
			return (
				<Snippet
					hint={
						<>
							Add to <InlineCode>~/.codeium/windsurf/mcp_config.json</InlineCode>
						</>
					}
					code={json}
					language="json"
				/>
			)
		case "other":
			return (
				<Snippet
					hint="Add the server URL to any client that supports remote MCP servers over HTTP"
					code={json}
					language="json"
				/>
			)
	}
}

function ConnectClientSection() {
	const [createDialogOpen, setCreateDialogOpen] = useState(false)
	const [createdSecret, setCreatedSecret] = useState<string | null>(null)
	const [client, setClient] = useState<McpClient>("claude-code")
	const apiKey = createdSecret ?? undefined

	return (
		<SettingsSection
			title="Connect a client"
			description="Add Maple as a remote MCP server in your editor or agent."
		>
			<div className="space-y-4">
				<CopyableField value={mcpEndpoint} label="Server URL" copyLabel="Server URL" />
				<Tabs
					value={client}
					onValueChange={(value) => {
						if (isMcpClient(value)) setClient(value)
					}}
				>
					<TabsList variant="underline">
						{MCP_CLIENTS.map(({ id, label }) => (
							<TabsTrigger key={id} value={id}>
								{label}
							</TabsTrigger>
						))}
					</TabsList>
					{MCP_CLIENTS.map(({ id }) => (
						<TabsContent key={id} value={id} className="pt-3">
							<ClientSnippets client={id} apiKey={apiKey} />
						</TabsContent>
					))}
				</Tabs>
				<div className="space-y-1 border-t pt-3 text-xs">
					<p className="text-muted-foreground">
						Your client opens Maple in the browser to approve access.
					</p>
					{createdSecret ? (
						<p className="text-muted-foreground">
							Key created and added to the snippets above. Manage it in{" "}
							<Link to="/settings" search={{ tab: "keys" }} className={keysLinkClass}>
								Keys
							</Link>
							.
						</p>
					) : (
						<p>
							Client without OAuth?{" "}
							<Button
								variant="link"
								size="xs"
								className="h-auto p-0 align-baseline text-xs underline underline-offset-2 hover:no-underline"
								onClick={() => setCreateDialogOpen(true)}
							>
								Create an MCP key
							</Button>{" "}
							in{" "}
							<Link to="/settings" search={{ tab: "keys" }} className={keysLinkClass}>
								Keys
							</Link>
						</p>
					)}
				</div>
			</div>
			<CreateApiKeyDialog
				open={createDialogOpen}
				onOpenChange={setCreateDialogOpen}
				onCreated={(secret) => setCreatedSecret(secret)}
				kind="mcp"
			/>
		</SettingsSection>
	)
}

export function McpSection() {
	return (
		<SettingsSections>
			<ConnectClientSection />
			<McpConnectedClientsSection />
			<McpToolsList />
		</SettingsSections>
	)
}
