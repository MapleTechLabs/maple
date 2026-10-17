import { useState } from "react"

import { BellIcon, FilterIcon, PlusIcon, TrashIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { FilterChip } from "@maple/ui/components/ui/filter-chip"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Kbd, KbdGroup } from "@maple/ui/components/ui/kbd"
import { RefreshButton } from "@maple/ui/components/ui/refresh-button"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Toggle } from "@maple/ui/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"

import { KitPage, KitRow, KitSection } from "./kit-layout"

const VARIANTS = [
	"default",
	"secondary",
	"outline",
	"ghost",
	"destructive",
	"destructive-outline",
	"link",
] as const
const TEXT_SIZES = ["xs", "sm", "default", "lg", "xl"] as const
const ICON_SIZES = ["icon-2xs", "icon-xs", "icon-sm", "icon", "icon-lg", "icon-xl"] as const
const BADGE_VARIANTS = [
	"default",
	"secondary",
	"outline",
	"muted",
	"meta",
	"destructive",
	"crit",
	"warn",
	"ok",
	"info",
	"done",
	"tag",
] as const
const BADGE_SIZES = ["xs", "sm", "default", "lg"] as const
const TONES = ["crit", "warn", "ok", "info", "done", "neutral", "live"] as const
const noop = () => {}

function FilterChips() {
	const [pressed, setPressed] = useState<Record<string, boolean>>({
		errors: true,
		warnings: false,
		ok: true,
	})
	const set = (key: string) => (next: boolean) => setPressed((prev) => ({ ...prev, [key]: next }))
	return (
		<KitRow>
			<FilterChip
				pressed={pressed.errors ?? false}
				onPressedChange={set("errors")}
				tone="crit"
				dot
				count={12}
			>
				Errors
			</FilterChip>
			<FilterChip
				pressed={pressed.warnings ?? false}
				onPressedChange={set("warnings")}
				tone="warn"
				dot
				count={4}
			>
				Warnings
			</FilterChip>
			<FilterChip pressed={pressed.ok ?? false} onPressedChange={set("ok")} tone="ok" size="xs">
				Healthy
			</FilterChip>
		</KitRow>
	)
}

export function KitButtonsLab() {
	return (
		<KitPage
			title="Kit: buttons"
			description="Buttons, toggles, chips, badges and inline marks from @maple/ui."
		>
			<KitSection title="Button variants x sizes">
				{VARIANTS.map((variant) => (
					<KitRow key={variant} label={variant}>
						{TEXT_SIZES.map((size) => (
							<Button key={size} variant={variant} size={size}>
								{size}
							</Button>
						))}
						{ICON_SIZES.map((size) => (
							<Button
								key={size}
								variant={variant}
								size={size}
								aria-label={`${variant} ${size}`}
							>
								<PlusIcon />
							</Button>
						))}
					</KitRow>
				))}
			</KitSection>
			<KitSection title="Button states">
				<KitRow>
					<Button>Save changes</Button>
					<Button variant="outline">Cancel edit</Button>
					<Button disabled>Disabled</Button>
					<Button variant="outline" disabled>
						Disabled outline
					</Button>
					<Button loading>Loading</Button>
					<Button variant="outline" loading>
						Loading outline
					</Button>
					<Button variant="outline">
						<PlusIcon /> With icon
					</Button>
				</KitRow>
			</KitSection>
			<KitSection title="Icon button">
				<KitRow>
					<IconButton label="Add widget">
						<PlusIcon />
					</IconButton>
					<IconButton label="Delete row" variant="outline">
						<TrashIcon />
					</IconButton>
					<IconButton label="Notifications" size="icon" shortcut="N">
						<BellIcon />
					</IconButton>
					<IconButton label="Filters disabled" disabled>
						<FilterIcon />
					</IconButton>
				</KitRow>
			</KitSection>
			<KitSection title="Toggle">
				<KitRow>
					<Toggle aria-label="Wrap lines">Wrap</Toggle>
					<Toggle aria-label="Wrap lines pressed" defaultPressed>
						Wrap
					</Toggle>
					<Toggle variant="outline" aria-label="Follow tail">
						Follow
					</Toggle>
					<Toggle variant="outline" defaultPressed aria-label="Follow tail pressed">
						Follow
					</Toggle>
					<Toggle size="xs">xs</Toggle>
					<Toggle size="sm">sm</Toggle>
					<Toggle size="lg">lg</Toggle>
					<Toggle disabled>Disabled</Toggle>
				</KitRow>
			</KitSection>
			<KitSection title="Toggle group">
				<KitRow label="outline (track)">
					<ToggleGroup variant="outline" defaultValue={["1h"]} aria-label="Window">
						<ToggleGroupItem value="15m">15m</ToggleGroupItem>
						<ToggleGroupItem value="1h">1h</ToggleGroupItem>
						<ToggleGroupItem value="24h">24h</ToggleGroupItem>
						<ToggleGroupItem value="7d">7d</ToggleGroupItem>
					</ToggleGroup>
				</KitRow>
				<KitRow label="default">
					<ToggleGroup defaultValue={["list"]} aria-label="Layout">
						<ToggleGroupItem value="list">List</ToggleGroupItem>
						<ToggleGroupItem value="grid">Grid</ToggleGroupItem>
					</ToggleGroup>
				</KitRow>
				<KitRow label="standalone, sm">
					<ToggleGroup
						variant="outline"
						connected={false}
						size="sm"
						defaultValue={["logs", "traces"]}
						multiple
						aria-label="Signals"
					>
						<ToggleGroupItem value="logs">Logs</ToggleGroupItem>
						<ToggleGroupItem value="traces">Traces</ToggleGroupItem>
						<ToggleGroupItem value="metrics">Metrics</ToggleGroupItem>
					</ToggleGroup>
				</KitRow>
			</KitSection>
			<KitSection title="Copy and refresh buttons">
				<KitRow>
					<CopyButton value="4bf92f3577b34da6a3ce929d0e0e4736" label="trace id" />
					<CopyButton
						value="maple_ingest_key"
						label="ingest key"
						idleLabel="Copy"
						variant="outline"
					/>
					<RefreshButton onRefresh={noop} />
					<RefreshButton onRefresh={noop} pending label="Refreshing" />
					<RefreshButton onRefresh={noop} iconOnly label="Reload data" />
				</KitRow>
			</KitSection>
			<KitSection title="Filter chip">
				<FilterChips />
			</KitSection>
			<KitSection title="Badge">
				<KitRow label="variants">
					{BADGE_VARIANTS.map((variant) => (
						<Badge key={variant} variant={variant}>
							{variant}
						</Badge>
					))}
				</KitRow>
				<KitRow label="sizes, pill, mono">
					{BADGE_SIZES.map((size) => (
						<Badge key={size} size={size} variant="secondary">
							{size}
						</Badge>
					))}
					<Badge pill variant="muted">
						pill
					</Badge>
					<Badge mono variant="outline">
						12,480
					</Badge>
				</KitRow>
			</KitSection>
			<KitSection title="Status dot">
				<KitRow>
					{TONES.map((tone) => (
						<span key={tone} className="flex items-center gap-1.5 text-xs">
							<StatusDot tone={tone} /> {tone}
						</span>
					))}
					<StatusDot tone="crit" size="sm" />
					<StatusDot tone="crit" size="lg" />
				</KitRow>
			</KitSection>
			<KitSection title="Kbd and inline code">
				<KitRow>
					<Kbd>K</Kbd>
					<KbdGroup>
						<Kbd>Cmd</Kbd>
						<Kbd>Shift</Kbd>
						<Kbd>P</Kbd>
					</KbdGroup>
					<span className="text-sm">
						Set <InlineCode>service.name</InlineCode> or run{" "}
						<InlineCode variant="plain">maple login</InlineCode>.
					</span>
				</KitRow>
			</KitSection>
		</KitPage>
	)
}
