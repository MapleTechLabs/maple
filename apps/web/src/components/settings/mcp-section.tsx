import { useState } from "react"
import { Link } from "@tanstack/react-router"

import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { Button } from "@maple/ui/components/ui/button"
import { PlusIcon } from "@/components/icons"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { mcpUrl } from "@/lib/services/common/mcp-url"
import { McpToolsList } from "@/components/mcp/mcp-tools-list"
import { CreateApiKeyDialog } from "@/components/settings/create-api-key-dialog"
import { CodeBlock } from "@/components/quick-start/code-block"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"

const mcpEndpoint = `${mcpUrl}/mcp`

function generateConfig(client: "claude-code" | "cursor" | "windsurf" | "other", apiKey?: string) {
	const isWindsurf = client === "windsurf"
	const urlKey = isWindsurf ? "serverUrl" : "url"
	const config = {
		mcpServers: {
			maple: {
				...(!isWindsurf ? { type: "http" } : undefined),
				[urlKey]: mcpEndpoint,
				...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined),
			},
		},
	}
	return JSON.stringify(config, null, 2)
}

function generateCliCommand(apiKey?: string) {
	return apiKey
		? `claude mcp add --transport http maple ${mcpEndpoint} \\
  --header "Authorization: Bearer ${apiKey}"`
		: `claude mcp add --transport http maple ${mcpEndpoint}`
}

const CONFIG_FILE_HINTS: Record<string, string> = {
	"claude-code": "~/.claude/claude_desktop_config.json",
	cursor: ".cursor/mcp.json",
	windsurf: "~/.codeium/windsurf/mcp_config.json",
	other: "",
} satisfies Record<string, string>

export function McpSection() {
	const [createDialogOpen, setCreateDialogOpen] = useState(false)
	const [createdSecret, setCreatedSecret] = useState<string | null>(null)
	const [configTab, setConfigTab] = useState("claude-code")

	return (
		<SettingsSections>
			<SettingsSection
				title="Server endpoint"
				description="Use this URL to connect MCP-compatible clients to Maple."
			>
				<div className="space-y-4">
					<CopyableField value={mcpEndpoint} copyLabel="MCP endpoint" />
					<div className="flex flex-wrap items-center gap-2">
						<p className="text-muted-foreground text-xs">
							Compatible clients open Maple in your browser and connect with OAuth.
						</p>
						{createdSecret && (
							<p className="text-severity-info text-xs font-medium">
								Key created. Config below is ready to copy.
							</p>
						)}
						<Button variant="outline" size="xs" onClick={() => setCreateDialogOpen(true)}>
							<PlusIcon data-icon="inline-start" />
							{createdSecret ? "Create another" : "Use API key fallback"}
						</Button>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				title="Quick setup"
				description="Add the server URL. Your client will open Maple to approve access to a workspace."
			>
				<Tabs value={configTab} onValueChange={setConfigTab}>
					<TabsList variant="underline">
						<TabsTrigger value="claude-code">Claude Code</TabsTrigger>
						<TabsTrigger value="cursor">Cursor</TabsTrigger>
						<TabsTrigger value="windsurf">Windsurf</TabsTrigger>
						<TabsTrigger value="other">Other</TabsTrigger>
					</TabsList>
					<TabsContent value="claude-code" className="pt-3">
						<div className="space-y-4">
							<div className="space-y-2">
								<p className="text-muted-foreground text-xs">Run in your terminal</p>
								<CodeBlock
									code={generateCliCommand(createdSecret ?? undefined)}
									language="bash"
								/>
							</div>
							<div className="space-y-2">
								<p className="text-muted-foreground text-xs">
									Or add to <InlineCode>{CONFIG_FILE_HINTS["claude-code"]}</InlineCode>
								</p>
								<CodeBlock
									code={generateConfig("claude-code", createdSecret ?? undefined)}
									language="json"
								/>
							</div>
						</div>
					</TabsContent>
					{(["cursor", "windsurf", "other"] as const).map((client) => (
						<TabsContent key={client} value={client} className="pt-3">
							<div className="space-y-2">
								{CONFIG_FILE_HINTS[client] && (
									<p className="text-muted-foreground text-xs">
										Add to <InlineCode>{CONFIG_FILE_HINTS[client]}</InlineCode>
									</p>
								)}
								<CodeBlock
									code={generateConfig(client, createdSecret ?? undefined)}
									language="json"
								/>
							</div>
						</TabsContent>
					))}
				</Tabs>
				{!createdSecret && (
					<p className="text-muted-foreground text-xs mt-3">
						Client does not support OAuth?{" "}
						<Button
							variant="link"
							size="xs"
							className="h-auto p-0 align-baseline underline underline-offset-2 hover:no-underline"
							onClick={() => setCreateDialogOpen(true)}
						>
							Create an MCP key
						</Button>{" "}
						or manage existing keys in{" "}
						<Link
							to="/settings"
							search={{ tab: "api-keys" }}
							className="text-foreground underline underline-offset-2 hover:no-underline"
						>
							API Keys
						</Link>
						.
					</p>
				)}
			</SettingsSection>

			<McpToolsList />

			<CreateApiKeyDialog
				open={createDialogOpen}
				onOpenChange={setCreateDialogOpen}
				onCreated={(secret) => setCreatedSecret(secret)}
				kind="mcp"
			/>
		</SettingsSections>
	)
}
