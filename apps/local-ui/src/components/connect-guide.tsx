// The one "how to send telemetry here" block: the Connect popover and every
// first-run empty state render this, so the endpoint and env vars never drift.

import type { ReactNode } from "react"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { LOCAL_OTLP_ENDPOINT } from "../lib/constants"
import { DOCS_LOCAL_MODE_SEND_TELEMETRY } from "../lib/links"

/**
 * The exporter env block. `http/protobuf` is spelled out because the server
 * speaks OTLP over HTTP only, and .NET and the Python distro default to gRPC.
 */
export function otelEnvBlock(serviceName = "my-service"): string {
	return [
		`OTEL_EXPORTER_OTLP_ENDPOINT=${LOCAL_OTLP_ENDPOINT}`,
		"OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
		`OTEL_SERVICE_NAME=${serviceName}`,
	].join("\n")
}

export function ConnectGuide({ note }: { note?: ReactNode }) {
	const env = otelEnvBlock()
	return (
		<div className="w-full space-y-3 text-left">
			<CopyableField label="OTLP/HTTP endpoint" value={LOCAL_OTLP_ENDPOINT} />
			<div className="space-y-1">
				<div className="flex items-center justify-between">
					<span className="text-xs text-muted-foreground">Exporter environment</span>
					<CopyButton value={env} label="Environment variables" idleLabel="Copy" iconSize={12} />
				</div>
				<pre className="overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed">
					{env}
				</pre>
			</div>
			<p className="text-xs text-muted-foreground">
				No API key needed. Local Maple takes OTLP over HTTP only, so keep the protocol line: .NET and
				the Python distro default to gRPC.
			</p>
			{note}
			<a
				href={DOCS_LOCAL_MODE_SEND_TELEMETRY}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
			>
				OTLP setup docs
			</a>
		</div>
	)
}
