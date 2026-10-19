import type { V2Source } from "@maple/domain/http/v2"
import { PushSourcePlatform } from "@maple/domain/primitives"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { useState } from "react"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { CreateSourceForm } from "@/components/sources/create-source-form"
import { PlatformPicker } from "@/components/sources/platform-picker"
import { platformMeta } from "@/components/sources/platforms"
import type { RevealedToken } from "@/components/sources/shared"
import { TokenStep } from "@/components/sources/token-step"

const NewSourceSearch = Schema.Struct({
	platform: Schema.optional(PushSourcePlatform),
})

export const Route = createFileRoute("/sources/new")({
	component: NewSourcePage,
	validateSearch: Schema.toStandardSchemaV1(NewSourceSearch),
})

interface Created {
	readonly source: V2Source
	readonly revealed: RevealedToken
}

function NewSourcePage() {
	const { platform } = Route.useSearch()
	const navigate = useNavigate({ from: "/sources/new" })
	// The token lives only in memory: a reload drops it, as it should.
	const [created, setCreated] = useState<Created | null>(null)
	const step = created !== null ? 3 : platform !== undefined ? 2 : 1

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Sources", href: "/sources" },
				{ label: platform !== undefined ? platformMeta(platform).label : "Connect source" },
			]}
			titleContent={
				<div className="space-y-1">
					<h1 className="font-display text-2xl font-medium tracking-tight">Connect a source</h1>
					<p className="text-muted-foreground text-sm">
						Step {step} of 3 ·{" "}
						{step === 1 ? "Pick what sends the data" : step === 2 ? "Name it" : "Send data"}
					</p>
				</div>
			}
		>
			{created !== null ? (
				<TokenStep source={created.source} revealed={created.revealed} />
			) : platform !== undefined ? (
				<CreateSourceForm
					platform={platform}
					onBack={() => navigate({ search: {} })}
					onCreated={(source, revealed) => setCreated({ source, revealed })}
				/>
			) : (
				<PlatformPicker
					onSelectPush={(next) => navigate({ search: { platform: next } })}
					onSelectPull={(integration) => navigate({ to: "/integrations", search: { integration } })}
				/>
			)}
		</DashboardPage>
	)
}
