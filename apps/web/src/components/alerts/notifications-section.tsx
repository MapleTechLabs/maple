import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { MiddleTruncate } from "@maple/ui/components/ui/middle-truncate"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import { useState, type Dispatch, type SetStateAction } from "react"
import { useUser } from "@clerk/clerk-react"

import { ALERT_TEMPLATE_VARIABLES, type AlertDestinationDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Panel } from "@maple/ui/components/ui/panel"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Input } from "@maple/ui/components/ui/input"
import { Textarea } from "@maple/ui/components/ui/textarea"

import {
	destinationProvider,
	destinationTypesFor,
	ProviderLogo,
} from "@/components/alerts/destination-provider"
import { useChatConnectors, useChatWorkspaceConnect } from "@/components/alerts/use-chat-workspaces"
import { SectionHeading } from "@/components/common/section-heading"
import {
	chatDestinationForm,
	defaultDestinationForm,
	type DestinationFormState,
	type RuleFormState,
} from "@/lib/alerts/form-utils"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	EnvelopeIcon,
	PaperPlaneIcon,
	PlusIcon,
	XmarkIcon,
} from "@/components/icons"

interface NotificationsSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	destinations: AlertDestinationDocument[]
	onSendTest: () => void
	testing: boolean
	/** Opens the destination dialog, preset to a provider when given. Absent for members, who cannot create one. */
	onAddDestination?: (preset?: DestinationFormState) => void
	/** Creates a destination with no dialog ("Email me"). Absent for members. */
	onQuickCreate?: (form: DestinationFormState) => Promise<boolean>
}

const TITLE_PLACEHOLDER = "{{ event.emoji }} {{ rule.name }} — {{ event.label }}"
const BODY_PLACEHOLDER = [
	// Only variables listed in ALERT_TEMPLATE_VARIABLES belong here — the
	// placeholder doubles as the reference for what's available.
	"{{ signal.label }} is *{{ value }}* ({{ comparator.label }} {{ threshold }}) over the last {{ window }}.",
	"*Severity:* {{ severity }} · *Group:* {{ group }}",
].join("\n")

/** Where a destination actually delivers, ahead of the name someone gave it. */
export function destinationTarget(destination: AlertDestinationDocument): {
	primary: string
	secondary: string
} {
	const provider = destinationProvider(destination).label
	const primary =
		destination.type === "chat" || destination.type === "hazel-oauth"
			? (destination.channelLabel ?? destination.name)
			: destination.type === "webhook"
				? destination.summary.replace(/^POST /, "")
				: destination.type === "email" || destination.type === "telegram"
					? destination.summary
					: destination.name
	const where = destination.type === "chat" ? destination.summary : null
	const secondary = [provider, where, primary.includes(destination.name) ? null : destination.name]
		.filter((part) => part !== null && part.length > 0)
		.join(" · ")
	return { primary, secondary }
}

/**
 * "Who gets notified": the places this rule's incidents go, as one list, plus a single menu that
 * picks an existing destination or makes a new one without leaving the form. Rows lead with the
 * real target (#channel, recipients, host) rather than whatever someone named the destination.
 */
export function NotificationsSection({
	form,
	onChange,
	destinations,
	onSendTest,
	testing,
	onAddDestination,
	onQuickCreate,
}: NotificationsSectionProps) {
	const selected = destinations.filter((d) => form.destinationIds.includes(d.id))
	const available = destinations.filter((d) => !form.destinationIds.includes(d.id))
	// Saved ids the list does not hold (deleted, or the list failed to load) still get notified on
	// save, so they stay on screen and removable rather than silently riding along.
	const unresolved = form.destinationIds.filter((id) => !destinations.some((d) => d.id === id))
	const canAdd = available.length > 0 || onAddDestination !== undefined

	const select = (id: AlertDestinationDocument["id"]) =>
		onChange((c) => ({ ...c, destinationIds: [...new Set([...c.destinationIds, id])] }))
	const remove = (id: AlertDestinationDocument["id"]) =>
		onChange((c) => ({ ...c, destinationIds: c.destinationIds.filter((existing) => existing !== id) }))

	return (
		<Card className="p-4">
			<div className="flex items-center justify-between gap-3">
				<SectionHeading
					variant="eyebrow"
					id="rule-notifications-heading"
					title="Who gets notified"
					className="mb-0"
				/>
				{selected.length > 0 && (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									variant="ghost"
									size="sm"
									onClick={onSendTest}
									loading={testing}
									className="-my-1 h-7 px-2 text-xs"
								/>
							}
						>
							<PaperPlaneIcon size={12} />
							Send test
						</TooltipTrigger>
						<TooltipContent>
							Send a real test notification to every destination below
						</TooltipContent>
					</Tooltip>
				)}
			</div>

			<Panel className="mt-3 divide-y divide-border/60 border-border/60">
				{selected.map((destination) => (
					<SelectedDestination
						key={destination.id}
						destination={destination}
						onRemove={() => remove(destination.id)}
					/>
				))}
				{unresolved.map((id) => (
					<div key={id} className="flex items-center gap-2.5 px-3 py-2">
						<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
							Destination unavailable
						</span>
						<IconButton
							className="-my-1 shrink-0 text-muted-foreground"
							label="Stop notifying this unavailable destination"
							onClick={() => remove(id)}
						>
							<XmarkIcon size={12} />
						</IconButton>
					</div>
				))}
				{selected.length === 0 && unresolved.length === 0 && (
					<p className="px-3 py-2.5 text-sm text-muted-foreground">
						{canAdd
							? "No one is notified yet."
							: "No destinations exist yet, and only an org admin can add one."}
					</p>
				)}
				{canAdd && (
					<AddDestinationMenu
						available={available}
						destinations={destinations}
						onSelect={select}
						onAddDestination={onAddDestination}
						onQuickCreate={onQuickCreate}
					/>
				)}
			</Panel>

			<MessageTemplate form={form} onChange={onChange} />
		</Card>
	)
}

function SelectedDestination({
	destination,
	onRemove,
}: {
	destination: AlertDestinationDocument
	onRemove: () => void
}) {
	const { primary, secondary } = destinationTarget(destination)
	const paused = destination.disabledAt
		? "Paused after repeated delivery failures"
		: destination.enabled
			? null
			: "Paused"
	return (
		<div className="flex items-center gap-2.5 px-3 py-2">
			<ProviderLogo
				type={destination.type}
				chatConnector={destination.chatConnector}
				size={30}
				bare
				className="flex shrink-0"
			/>
			<MiddleTruncate text={primary} tail={16} className="text-sm font-medium" />
			<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
				{paused ? <span className="text-severity-error">{paused} · </span> : null}
				{secondary}
			</span>
			<IconButton
				className="-my-1 shrink-0 text-muted-foreground"
				label={`Stop notifying ${primary}`}
				onClick={onRemove}
			>
				<XmarkIcon size={12} />
			</IconButton>
		</div>
	)
}

/**
 * One menu for every way to add a recipient: an existing destination, a one-click "Email me", or a
 * new one per provider. Chat platforms that are not linked yet link in a popup first; the connect
 * hook lives here, outside the menu, so closing the menu does not stop it watching the popup.
 */
function AddDestinationMenu({
	available,
	destinations,
	onSelect,
	onAddDestination,
	onQuickCreate,
}: {
	available: AlertDestinationDocument[]
	destinations: AlertDestinationDocument[]
	onSelect: (id: AlertDestinationDocument["id"]) => void
	onAddDestination?: (preset?: DestinationFormState) => void
	onQuickCreate?: (form: DestinationFormState) => Promise<boolean>
}) {
	const connectors = useChatConnectors()
	const chatConnect = useChatWorkspaceConnect({
		onLinked: (workspace) => onAddDestination?.(chatDestinationForm(workspace.connector, workspace.id)),
	})
	const discordLinked = connectors.some((c) => c.id === "discord" && c.workspaces.length > 0)
	const newTypes = destinationTypesFor(discordLinked)
	// The trigger previews where alerts can go: chat platforms first, then the other providers.
	const previewChat = connectors.filter(
		(c) => c.workspaces.length > 0 || (c.available && c.id !== "discord"),
	)
	const waiting = connectors.find((c) => c.id === chatConnect.waitingFor)

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						type="button"
						className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
					/>
				}
			>
				{waiting ? <Spinner size={14} /> : <PlusIcon size={14} />}
				{waiting ? `Finish connecting ${waiting.name} in the other window…` : "Add destination"}
				{waiting ? null : (
					<span aria-hidden className="ml-auto flex items-center gap-1.5">
						{previewChat.map((connector) => (
							<ProviderLogo
								key={connector.id}
								type="chat"
								chatConnector={connector.id}
								size={30}
								bare
								className="flex"
							/>
						))}
						{newTypes.slice(0, 5).map((type) => (
							<ProviderLogo key={type} type={type} size={30} bare className="flex" />
						))}
					</span>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72">
				{available.length > 0 && (
					<DropdownMenuGroup>
						<DropdownMenuLabel>Existing</DropdownMenuLabel>
						{available.map((destination) => {
							const { primary, secondary } = destinationTarget(destination)
							return (
								<DropdownMenuItem
									key={destination.id}
									onClick={() => onSelect(destination.id)}
								>
									<ProviderLogo
										type={destination.type}
										chatConnector={destination.chatConnector}
										size={30}
										bare
										className="flex shrink-0"
									/>
									<MiddleTruncate text={primary} tail={16} className="flex-1" />
									<span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
										{secondary}
									</span>
								</DropdownMenuItem>
							)
						})}
					</DropdownMenuGroup>
				)}
				{onAddDestination && (
					<>
						{available.length > 0 && <DropdownMenuSeparator />}
						<DropdownMenuGroup>
							<DropdownMenuLabel>New destination</DropdownMenuLabel>
							{isClerkAuthEnabled && onQuickCreate ? (
								<EmailMeItem destinations={destinations} onQuickCreate={onQuickCreate} />
							) : null}
							{connectors.flatMap((connector) => {
								const logo = (
									<ProviderLogo
										type="chat"
										chatConnector={connector.id}
										size={30}
										bare
										className="flex shrink-0"
									/>
								)
								if (connector.workspaces.length > 0) {
									return connector.workspaces.map((workspace) => (
										<DropdownMenuItem
											key={workspace.id}
											onClick={() =>
												onAddDestination(
													chatDestinationForm(connector.id, workspace.id),
												)
											}
										>
											{logo}
											<span className="flex-1">{connector.name}</span>
											{connector.workspaces.length > 1 && (
												<span className="max-w-28 truncate text-xs text-muted-foreground">
													{workspace.name}
												</span>
											)}
										</DropdownMenuItem>
									))
								}
								if (!connector.available || connector.id === "discord") return []
								return [
									<DropdownMenuItem
										key={connector.id}
										onClick={() => chatConnect.connect(connector)}
									>
										{logo}
										<span className="flex-1">{connector.name}</span>
										<span className="text-xs text-muted-foreground">Connect</span>
									</DropdownMenuItem>,
								]
							})}
							{newTypes.map((type) => (
								<DropdownMenuItem
									key={type}
									onClick={() => onAddDestination(defaultDestinationForm(type))}
								>
									<ProviderLogo type={type} size={30} bare className="flex shrink-0" />
									{destinationProvider({ type }).label}
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/** One-click email to the signed-in admin: the shortest path to a rule that can be saved. */
function EmailMeItem({
	destinations,
	onQuickCreate,
}: {
	destinations: AlertDestinationDocument[]
	onQuickCreate: (form: DestinationFormState) => Promise<boolean>
}) {
	const { user } = useUser()
	if (!user) return null
	const alreadyExists = destinations.some(
		(d) => d.type === "email" && d.memberUserIds?.length === 1 && d.memberUserIds[0] === user.id,
	)
	if (alreadyExists) return null
	const email = user.primaryEmailAddress?.emailAddress
	return (
		<DropdownMenuItem
			onClick={() =>
				void onQuickCreate({
					...defaultDestinationForm("email"),
					name: email ? `Email ${email}` : "Email me",
					memberUserIds: [user.id],
				})
			}
		>
			<EnvelopeIcon size={16} className="shrink-0" />
			<span className="flex-1">Email me</span>
			{email ? <span className="max-w-32 truncate text-xs text-muted-foreground">{email}</span> : null}
		</DropdownMenuItem>
	)
}

function MessageTemplate({
	form,
	onChange,
}: {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
}) {
	const hasTemplate = form.notificationTitle.length > 0 || form.notificationBody.length > 0
	const [open, setOpen] = useState(hasTemplate)

	const appendToBody = (token: string) =>
		onChange((c) => ({
			...c,
			notificationBody: c.notificationBody.length > 0 ? `${c.notificationBody} ${token}` : token,
		}))

	return (
		<div className="mt-3">
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
				aria-expanded={open}
			>
				<span className="flex items-center gap-1.5">
					{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
					Message template
				</span>
				{hasTemplate && !open && (
					<span className="rounded-full bg-primary/10 px-2 py-0.5 text-3xs text-primary">
						Customized
					</span>
				)}
			</button>

			{open && (
				<div className="mt-3 space-y-3">
					<p className="text-muted-foreground text-xs">
						Customize the Slack / Discord / PagerDuty message. Leave blank to use Maple's default
						format. Supports <InlineCode>{"{{ variable }}"}</InlineCode> substitution.
					</p>

					<Field className="items-stretch gap-1.5">
						<FieldLabel htmlFor="notification-title">Title</FieldLabel>
						<Input
							id="notification-title"
							value={form.notificationTitle}
							onChange={(e) => onChange((c) => ({ ...c, notificationTitle: e.target.value }))}
							placeholder={TITLE_PLACEHOLDER}
						/>
					</Field>

					<Field className="items-stretch gap-1.5">
						<FieldLabel htmlFor="notification-body">Body (Markdown)</FieldLabel>
						<Textarea
							id="notification-body"
							value={form.notificationBody}
							onChange={(e) => onChange((c) => ({ ...c, notificationBody: e.target.value }))}
							placeholder={BODY_PLACEHOLDER}
							rows={4}
							className="font-mono text-xs"
						/>
					</Field>

					<div className="space-y-1.5">
						<span className="text-muted-foreground text-xs">Insert a variable:</span>
						<div className="flex flex-wrap gap-1">
							{ALERT_TEMPLATE_VARIABLES.map((variable) => (
								<Tooltip key={variable.key}>
									<TooltipTrigger
										render={
											<button
												type="button"
												onClick={() => appendToBody(`{{ ${variable.key} }}`)}
												className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground hover:border-border hover:text-foreground"
											/>
										}
									>
										{variable.key}
									</TooltipTrigger>
									<TooltipContent>{variable.description}</TooltipContent>
								</Tooltip>
							))}
						</div>
					</div>
				</div>
			)}
		</div>
	)
}
