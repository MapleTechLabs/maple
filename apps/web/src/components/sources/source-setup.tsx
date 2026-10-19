import type { SourcePlatform } from "@maple/domain/primitives"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Panel } from "@maple/ui/components/ui/panel"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { useState } from "react"
import { CodeBlock } from "@/components/quick-start/code-block"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { maskedToken, sourceSnippets } from "./snippets"

/**
 * Endpoint, token and the platform's setup snippets. Pass `token` only right after a create
 * or roll; otherwise the snippets carry a masked token built from `keyPrefix`.
 */
export function SourceSetup({
	platform,
	name,
	token,
	keyPrefix,
}: {
	platform: SourcePlatform
	name: string
	token: string | null
	keyPrefix: string | null
}) {
	const shown = token ?? maskedToken(keyPrefix)
	const snippets = sourceSnippets(platform, shown, name)
	const [selected, setSelected] = useState(snippets[0]?.id ?? "")
	const snippet = snippets.find((entry) => entry.id === selected) ?? snippets[0]

	return (
		<div className="flex flex-col gap-4">
			<Panel padded className="gap-3">
				<div className="flex flex-col gap-1.5">
					<Eyebrow>OTLP endpoint</Eyebrow>
					<CopyableField value={ingestUrl} copyLabel="OTLP endpoint" />
				</div>
				<div className="flex flex-col gap-1.5">
					<Eyebrow>Header</Eyebrow>
					{token === null ? (
						<div className="bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 font-mono text-xs">
							Authorization: Bearer {shown}
						</div>
					) : (
						<CopyableField value={`Authorization: Bearer ${token}`} copyLabel="Header" />
					)}
				</div>
			</Panel>
			{snippet !== undefined && (
				<div className="flex flex-col gap-2">
					{snippets.length > 1 && (
						<Tabs value={snippet.id} onValueChange={(value) => setSelected(String(value))}>
							<TabsList variant="underline">
								{snippets.map((entry) => (
									<TabsTrigger key={entry.id} value={entry.id}>
										{entry.label}
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
					)}
					<CodeBlock
						code={snippet.code}
						language={snippets.length > 1 ? snippet.language : snippet.label}
					/>
				</div>
			)}
			{token === null && (
				<p className="text-muted-foreground text-xs">
					The token is only shown when the source is created or rolled. Roll it to get a new one.
				</p>
			)}
		</div>
	)
}
