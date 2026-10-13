import { Spinner } from "@maple/ui/components/ui/spinner"
import { initialsFrom } from "@maple/ui/lib/initials"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { HazelStartConnectRequest, type AlertDestinationType } from "@maple/domain/http"
import {
	type DestinationFormState,
	defaultDestinationForm,
	chatDestinationForm,
	MAX_EMAIL_MEMBER_RECIPIENTS,
	suggestedDestinationName,
} from "@/lib/alerts/form-utils"
import {
	chatDestinationProvider,
	destinationProvider,
	destinationTypesFor,
	PROVIDERS,
	ProviderLogo,
	type DestinationProvider,
} from "@/components/alerts/destination-provider"
import { chatIntegrationId } from "@/components/integrations/integration-catalog"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useChatConnectors, useChatWorkspaceConnect } from "@/components/alerts/use-chat-workspaces"
import { ArrowRightIcon, CircleInfoIcon, HazelIcon, MagnifierIcon } from "@/components/icons"
import {
	CHANNEL_RESULT_LIMIT,
	channelLabel,
	channelPickerView,
	resolveSearchQuery,
} from "@/components/alerts/channel-search"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { displayError } from "@/lib/error-messages"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { HazelChannelsListResponse } from "@maple/domain/http"
import type { V2ChatDestinationList, V2TelegramChat } from "@maple/domain/http/v2"
import { Exit, Option } from "effect"
import { Link } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Panel } from "@maple/ui/components/ui/panel"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { RefreshButton } from "@maple/ui/components/ui/refresh-button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxStatus,
} from "@maple/ui/components/ui/combobox"
import { LoadMoreButton } from "@maple/ui/components/ui/list-footer"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Switch } from "@maple/ui/components/ui/switch"
import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { MultiSelectCombobox } from "@maple/ui/components/multi-select-combobox"
import { cn } from "@maple/ui/lib/utils"
import { useOrganization } from "@clerk/clerk-react"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { currentReturnPath } from "@/components/integrations/integration-connect"

interface DestinationDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	form: DestinationFormState
	onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
	isEditing: boolean
	saving: boolean
	onSave: () => void
	/** Opened on a provider picked elsewhere: show it folded, with a way back to the full grid. */
	providerLocked?: boolean
	onUnlockProvider?: () => void
}

/**
 * A PagerDuty Events API v2 integration ("routing") key is exactly 32
 * alphanumeric characters. The common mistake is pasting a shorter REST API
 * token; this catches it before the server round-trip.
 */
const isValidPagerDutyKey = (key: string): boolean => /^[A-Za-z0-9]{32}$/.test(key.trim())

/**
 * Mirrors `TELEGRAM_BOT_TOKEN_PATTERN` on the server. Only gates the "Detect
 * chats" button — the server re-checks, and it owns the message shown on save.
 */
const isValidTelegramToken = (token: string): boolean => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim())

const TELEGRAM_CHAT_TYPE_LABELS = {
	private: "Direct message",
	group: "Group",
	supergroup: "Group",
	channel: "Channel",
} satisfies Record<V2TelegramChat["type"], string>

function isFormReady(form: DestinationFormState, isEditing: boolean): boolean {
	// A new destination left unnamed is named after where it delivers (`suggestedDestinationName`).
	if (isEditing && form.name.trim().length === 0) return false
	switch (form.type) {
		case "hazel-oauth":
			return form.hazelOrganizationId.trim().length > 0 && form.hazelChannelId.trim().length > 0
		// On create the secret is required; when editing, a blank value keeps the
		// stored one.
		case "discord":
			return isEditing || form.webhookUrl.trim().length > 0
		case "telegram":
			// The chat id is not a secret and is never returned, so editing always
			// requires it; the token may stay blank to keep the stored one.
			return (
				form.telegramChatId.trim().length > 0 &&
				(isEditing || form.telegramBotToken.trim().length > 0)
			)
		case "pagerduty":
			// Editing with a blank key keeps the stored one; otherwise require a
			// well-formed routing key.
			return isEditing && form.integrationKey.trim().length === 0
				? true
				: isValidPagerDutyKey(form.integrationKey)
		case "email":
			// The current selection is prefilled when editing, so a member is
			// always required.
			return form.memberUserIds.length > 0 && form.memberUserIds.length <= MAX_EMAIL_MEMBER_RECIPIENTS
		case "chat":
			// Editing keeps the stored channel when left untouched; creating requires a pick.
			return form.chatWorkspaceId !== null && (isEditing || form.chatChannelId.length > 0)
		default:
			return true
	}
}

function ProviderTile({
	type,
	chatConnector,
	label,
	description,
	selected,
	busy = false,
	onSelect,
}: {
	type: AlertDestinationType
	chatConnector?: string
	/** In place of the provider's own label — a chat tile names its workspace. */
	label?: string
	description?: string
	selected: boolean
	busy?: boolean
	onSelect: () => void
}) {
	const provider = destinationProvider({ type, chatConnector })
	return (
		<button
			type="button"
			onClick={onSelect}
			disabled={busy}
			aria-pressed={selected}
			className={cn(
				"relative flex flex-col items-start gap-2 overflow-hidden rounded-md border p-3 text-left transition-colors",
				selected
					? "border-(--tile-accent) bg-muted/40"
					: "border-border/60 bg-card hover:border-border hover:bg-muted/40",
			)}
			style={{ ["--tile-accent" as string]: provider.accent }}
		>
			<span
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-0 transition-opacity",
					selected ? "opacity-100" : "opacity-0",
				)}
				style={{
					background: `radial-gradient(circle at 0% 0%, ${provider.accentBg}, transparent 60%)`,
				}}
			/>
			<div className="relative flex w-full items-center gap-2.5">
				<ProviderLogo type={type} chatConnector={chatConnector} size={32} />
				<span className="truncate text-sm font-semibold">{label ?? provider.label}</span>
				{busy ? <Spinner size={12} className="ml-auto" /> : null}
			</div>
			<p className="relative text-2xs leading-snug text-muted-foreground">
				{description ?? provider.description}
			</p>
		</button>
	)
}

/**
 * Workspace-member recipient picker. Members come from Clerk's frontend
 * memberships hook — the server re-resolves the selected ids to emails via the
 * Clerk backend on save, so this list is a convenience, not a trust boundary.
 */
function EmailMemberPicker({
	form,
	onFormChange,
}: {
	form: DestinationFormState
	onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
}) {
	// pageSize is bumped well past Clerk's default of 10 so the combobox's
	// typeahead searches the whole workspace in one page for all but the largest
	// orgs; "Load more" in the popup footer covers the rest.
	const { memberships, isLoaded } = useOrganization({
		memberships: { infinite: true, pageSize: 100 },
	})

	const options = (memberships?.data ?? []).flatMap((member) => {
		const userId = member.publicUserData?.userId
		const email = member.publicUserData?.identifier
		if (!userId || !email) return []
		const name = [member.publicUserData?.firstName, member.publicUserData?.lastName]
			.filter(Boolean)
			.join(" ")
		return [
			{
				value: userId,
				label: name || email,
				adornment: (
					<Avatar className="size-5">
						<AvatarImage alt={name || email} src={member.publicUserData?.imageUrl} />
						<AvatarFallback>{initialsFrom(name || email)}</AvatarFallback>
					</Avatar>
				),
				meta: name ? email : undefined,
			},
		]
	})

	return (
		<Field className="items-stretch gap-1.5">
			<FieldLabel className="text-xs">Recipients</FieldLabel>
			<MultiSelectCombobox
				emptyMessage={isLoaded ? "No members found in this workspace." : "Loading members…"}
				footer={
					memberships?.hasNextPage ? (
						<LoadMoreButton
							variant="ghost"
							className="w-full text-xs"
							onClick={() => memberships.fetchNext?.()}
						/>
					) : undefined
				}
				onChange={(memberUserIds) => onFormChange((current) => ({ ...current, memberUserIds }))}
				options={options}
				placeholder={form.memberUserIds.length === 0 ? "Select members…" : "Add member..."}
				value={form.memberUserIds}
			/>
			<FieldDescription className="text-2xs">
				Alert emails go to the selected workspace members (up to {MAX_EMAIL_MEMBER_RECIPIENTS}).
			</FieldDescription>
			{form.memberUserIds.length > MAX_EMAIL_MEMBER_RECIPIENTS && (
				<FieldError match className="text-2xs">
					Select at most {MAX_EMAIL_MEMBER_RECIPIENTS} members.
				</FieldError>
			)}
		</Field>
	)
}

function HazelOrgAvatar({
	logoUrl,
	name,
	size = 16,
}: {
	logoUrl: string | null
	name: string
	size?: number
}) {
	const [errored, setErrored] = useState(false)
	if (logoUrl && !errored) {
		return (
			<img
				src={logoUrl}
				alt={`${name} logo`}
				width={size}
				height={size}
				loading="lazy"
				referrerPolicy="no-referrer"
				onError={() => setErrored(true)}
				className="shrink-0 rounded-sm object-cover"
				style={{ width: size, height: size }}
			/>
		)
	}
	// Fallback: a tinted square with the Hazel mark, mirroring ProviderLogo's
	// visual language but at compact size.
	const inner = Math.round(size * 0.7)
	return (
		<span
			className="flex shrink-0 items-center justify-center rounded-sm"
			style={{
				width: size,
				height: size,
				background: "rgba(244,111,15,0.16)",
				color: "#F46F0F",
			}}
		>
			<HazelIcon size={inner} />
		</span>
	)
}

function HazelOAuthFields({
	form,
	onFormChange,
	isEditing,
}: {
	form: DestinationFormState
	onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
	isEditing: boolean
}) {
	const statusResult = useAtomValue(
		retainedInternalQuery("integrations", "hazelStatus", {
			reactivityKeys: ["hazelIntegrationStatus"],
		}),
	)
	const organizationsAtom = retainedInternalQuery("integrations", "hazelOrganizations", {
		reactivityKeys: ["hazelIntegrationStatus", "hazelOrganizations"],
	})
	const organizationsResult = useAtomValue(organizationsAtom)

	const orgIdForChannels = form.hazelOrganizationId.trim()
	const channelsAtom =
		orgIdForChannels.length > 0
			? retainedInternalQuery("integrations", "hazelChannels", {
					params: { organizationId: orgIdForChannels },
					reactivityKeys: ["hazelIntegrationStatus", "hazelChannels", orgIdForChannels],
				})
			: disabledResultAtom<HazelChannelsListResponse>()
	const channelsResult = useAtomValue(channelsAtom)

	const startConnect = useAtomSet(MapleInternalAtomClient.mutation("integrations", "hazelStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleInternalAtomClient.mutation("integrations", "hazelDisconnect"), {
		mode: "promiseExit",
	})

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)

	const organizations = Result.builder(organizationsResult)
		.onSuccess((o) => [...o.organizations])
		.orElse(() => [] as Array<{ id: string; name: string; slug: string | null; logoUrl: string | null }>)

	const channels = Result.builder(channelsResult)
		.onSuccess((c) => [...c.channels])
		.orElse(
			() =>
				[] as Array<{ id: string; name: string; type: "public" | "private"; organizationId: string }>,
		)
	const channelsLoading = orgIdForChannels.length > 0 && channelsResult.waiting

	// Surface failures explicitly. Without these, an OAuth/API error renders
	// identically to "not connected" / "no data", silently hiding the problem.
	const statusFailed = Result.isFailure(statusResult)
	const organizationsFailed = Result.isFailure(organizationsResult)
	const channelsFailed = Result.isFailure(channelsResult)

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.data && event.data.type === "maple:integration:hazel") {
				// Bust by toggling form state so the reactivity-keyed atoms refetch.
				onFormChange((current) => ({ ...current }))
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [onFormChange])

	const [handleConnect, connecting] = useAsyncAction(async () => {
		// Open the popup synchronously to satisfy popup-blocker user-gesture rules,
		// then point it at the OAuth URL once the start mutation returns.
		const popup = window.open("", "maple-hazel-connect", "popup,width=520,height=640")
		const result = await startConnect({
			payload: new HazelStartConnectRequest({ returnTo: currentReturnPath() }),
			reactivityKeys: ["hazelIntegrationStatus"],
		})
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup) popup.location.href = url
			else window.open(url, "maple-hazel-connect", "popup,width=520,height=640")
		} else {
			popup?.close()
		}
	})

	const [handleDisconnect, disconnecting] = useAsyncAction(async () => {
		await disconnect({
			reactivityKeys: ["hazelIntegrationStatus", "hazelOrganizations", "hazelChannels"],
		})
		onFormChange((current) => ({
			...current,
			hazelOrganizationId: "",
			hazelOrganizationName: "",
			hazelOrganizationLogoUrl: null,
			hazelChannelId: "",
			hazelChannelName: "",
		}))
	})
	const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

	if (!status || !status.connected) {
		return (
			<div className="space-y-2 rounded-md border border-dashed border-border/60 p-3">
				{statusFailed ? (
					<p className="text-xs text-severity-error">
						Couldn't check your Hazel connection status. This may be a temporary issue — try
						connecting again.
					</p>
				) : null}
				<p className="text-xs text-muted-foreground">
					Connect Maple to your Hazel account via OAuth. We'll fetch the organizations and channels
					you can post into and provision a dedicated webhook for this destination.
				</p>
				<Button
					type="button"
					size="sm"
					onClick={() => void handleConnect()}
					loading={connecting}
					disabled={disconnecting}
					// Same brand fill as the save button below, so it takes the same
					// measured ink instead of a second copy of the hex + white.
					style={{
						background: PROVIDERS["hazel-oauth"].accent,
						borderColor: PROVIDERS["hazel-oauth"].accent,
						color: connecting ? "transparent" : PROVIDERS["hazel-oauth"].accentOn,
					}}
				>
					Connect Hazel
				</Button>
			</div>
		)
	}

	const selectedOrg = organizations.find((o) => o.id === form.hazelOrganizationId)
	const selectedOrgLogoUrl = selectedOrg?.logoUrl ?? form.hazelOrganizationLogoUrl ?? null
	const selectedOrgName = selectedOrg?.name ?? form.hazelOrganizationName ?? ""

	const orgSelectItems = organizations.map((o) => ({ value: o.id, label: o.name }))
	const channelSelectItems = channels.map((c) => ({
		value: c.id,
		label: c.type === "private" ? `${c.name} (private)` : c.name,
	}))

	return (
		<div className="space-y-3">
			<Panel className="flex-row items-center justify-between px-3 py-2 text-xs">
				<div className="space-y-0.5">
					<div className="font-medium">Connected to Hazel</div>
					<div className="text-muted-foreground">
						{status.externalUserEmail ?? status.externalUserId ?? "Authorized"}
					</div>
				</div>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => setConfirmingDisconnect(true)}
					loading={disconnecting}
					disabled={connecting}
				>
					Disconnect
				</Button>
			</Panel>
			<Field className="items-stretch gap-1.5">
				<FieldLabel htmlFor="destination-hazel-organization" className="text-xs">
					Hazel organization
				</FieldLabel>
				<Select
					items={orgSelectItems}
					defaultValue={form.hazelOrganizationId || null}
					onValueChange={(value) => {
						const org = organizations.find((o) => o.id === value)
						onFormChange((current) => ({
							...current,
							hazelOrganizationId: value ?? "",
							hazelOrganizationName: org?.name ?? "",
							hazelOrganizationLogoUrl: org?.logoUrl ?? null,
							hazelChannelId: "",
							hazelChannelName: "",
						}))
					}}
				>
					<SelectTrigger id="destination-hazel-organization" className="w-full">
						{selectedOrgName ? (
							<span className="flex items-center gap-2">
								<HazelOrgAvatar logoUrl={selectedOrgLogoUrl} name={selectedOrgName} />
								<span className="truncate">{selectedOrgName}</span>
							</span>
						) : (
							<SelectValue placeholder="Pick an organization" />
						)}
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{organizations.map((org) => (
								<SelectItem key={org.id} value={org.id}>
									<span className="flex items-center gap-2">
										<HazelOrgAvatar logoUrl={org.logoUrl} name={org.name} />
										<span className="truncate">{org.name}</span>
									</span>
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				{organizationsFailed ? (
					<FieldError match className="text-2xs">
						Couldn't load your Hazel organizations. Try reconnecting or refreshing.
					</FieldError>
				) : organizations.length === 0 ? (
					<p className="text-2xs text-muted-foreground">
						No organizations returned. Make sure your Hazel account is a member of at least one
						organization.
					</p>
				) : null}
			</Field>
			<Field className="items-stretch gap-1.5">
				<FieldLabel htmlFor="destination-hazel-channel" className="text-xs">
					Hazel channel
				</FieldLabel>
				<Select
					items={channelSelectItems}
					defaultValue={form.hazelChannelId || null}
					onValueChange={(value) => {
						const ch = channels.find((c) => c.id === value)
						onFormChange((current) => ({
							...current,
							hazelChannelId: value ?? "",
							hazelChannelName: ch?.name ?? current.hazelChannelName,
						}))
					}}
					disabled={orgIdForChannels.length === 0 || channelsLoading}
				>
					<SelectTrigger id="destination-hazel-channel" className="w-full">
						<SelectValue
							placeholder={
								orgIdForChannels.length === 0
									? "Pick an organization first"
									: channelsLoading
										? "Loading channels…"
										: isEditing && form.hazelChannelName
											? `#${form.hazelChannelName}`
											: "Pick a channel"
							}
						/>
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{channelSelectItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									#{item.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				{orgIdForChannels.length > 0 && !channelsLoading && channelsFailed ? (
					<FieldError match className="text-2xs">
						Couldn't load channels for this organization. Try reselecting the organization.
					</FieldError>
				) : orgIdForChannels.length > 0 && !channelsLoading && channels.length === 0 ? (
					<p className="text-2xs text-muted-foreground">
						No channels. Make sure your account is in at least one channel of this organization.
					</p>
				) : null}
			</Field>
			<ConfirmDialog
				open={confirmingDisconnect}
				onOpenChange={setConfirmingDisconnect}
				title="Disconnect Hazel"
				description="Maple loses access to your Hazel organizations and channels until you reconnect."
				confirmLabel="Disconnect Hazel"
				onConfirm={() => {
					setConfirmingDisconnect(false)
					void handleDisconnect()
				}}
			/>
		</div>
	)
}

/**
 * Every provider, in the order people reach for them: chat platforms first (a linked workspace, or
 * a tile that links one in a popup), then the rest. Discord
 * shows once: as its linked workspaces when the bot is installed, otherwise as the webhook type.
 */
function ProviderPicker({
	form,
	onFormChange,
}: {
	form: DestinationFormState
	onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
}) {
	const connectors = useChatConnectors()
	const chatConnect = useChatWorkspaceConnect({
		onLinked: (workspace) => onFormChange(() => chatDestinationForm(workspace.connector, workspace.id)),
	})
	const discordLinked = connectors.some((c) => c.id === "discord" && c.workspaces.length > 0)
	const types = destinationTypesFor(discordLinked)

	const tile = (type: AlertDestinationType) => (
		<ProviderTile
			key={type}
			type={type}
			label={type === "discord" && discordLinked ? "Discord webhook" : undefined}
			selected={form.type === type}
			onSelect={() => onFormChange(() => defaultDestinationForm(type))}
		/>
	)

	return (
		<div className="grid grid-cols-2 gap-2">
			{connectors.flatMap((connector) =>
				connector.workspaces.length > 0
					? connector.workspaces.map((workspace) => (
							<ProviderTile
								key={workspace.id}
								type="chat"
								chatConnector={connector.id}
								label={
									connector.workspaces.length > 1
										? `${connector.name} · ${workspace.name}`
										: connector.name
								}
								description={`Post to a channel in ${workspace.name}.`}
								selected={form.type === "chat" && form.chatWorkspaceId === workspace.id}
								onSelect={() =>
									onFormChange(() => chatDestinationForm(connector.id, workspace.id))
								}
							/>
						))
					: connector.available && connector.id !== "discord"
						? [
								<ProviderTile
									key={connector.id}
									type="chat"
									chatConnector={connector.id}
									label={connector.name}
									description={
										chatConnect.waitingFor === connector.id
											? `Finish in the ${connector.name} window. This form stays as it is.`
											: `Connect a ${connector.name} workspace, then pick a channel.`
									}
									selected={false}
									busy={chatConnect.waitingFor === connector.id}
									onSelect={() => chatConnect.connect(connector)}
								/>,
							]
						: [],
			)}
			{types.map(tile)}
		</div>
	)
}

/**
 * The channel a `chat` destination posts to, picked from what the workspace's connector says the
 * bot can post in. The same ranked, capped search as the other channel pickers.
 */
function ChatDestinationFields({
	form,
	onFormChange,
	isEditing,
}: {
	form: DestinationFormState
	onFormChange: (updater: (current: DestinationFormState) => DestinationFormState) => void
	isEditing: boolean
}) {
	const connectorName = chatDestinationProvider(form.chatConnector).label
	const workspaceId = form.chatWorkspaceId
	// No workspace (a stored destination that predates the field) is nothing to list: the shared
	// disabled atom, never a request with an empty id.
	const channelsAtom =
		workspaceId === null
			? disabledResultAtom<V2ChatDestinationList>()
			: retainedQueryV2("chatIntegration", "destinations", {
					params: { id: workspaceId },
					reactivityKeys: ["chatIntegration"],
				})
	const channelsResult = useAtomValue(channelsAtom)
	const refreshChannelsAtom = useAtomRefresh(channelsAtom)
	// Refreshing the shared disabled atom would poke every disabled reader in the app.
	const refreshChannels = workspaceId === null ? () => {} : refreshChannelsAtom
	// A failed refetch keeps the last list, as the other channel pickers do: emptying the picker
	// mid-selection would silently drop the channel being picked.
	const channels = useMemo(() => {
		const response = Result.isSuccess(channelsResult)
			? channelsResult.value
			: Result.isFailure(channelsResult)
				? Option.getOrNull(Option.map(channelsResult.previousSuccess, (previous) => previous.value))
				: null
		return (response?.destinations ?? []).map((destination) => ({
			id: destination.id,
			name: destination.name,
			is_private: destination.private,
			// Whatever the connector lists is somewhere it can post.
			is_member: true,
		}))
	}, [channelsResult])
	const channelsLoading = workspaceId !== null && channelsResult.waiting

	const [channelQuery, setChannelQuery] = useState("")
	const selectedChannel = channels.find((channel) => channel.id === form.chatChannelId)
	const searchQuery = resolveSearchQuery(channelQuery, selectedChannel)
	const { visible: visibleChannels, truncated } = useMemo(
		() => channelPickerView(channels, searchQuery, form.chatChannelId || null),
		[channels, searchQuery, form.chatChannelId],
	)
	const visibleChannelIds = useMemo(() => visibleChannels.map((channel) => channel.id), [visibleChannels])

	const failure = Result.isFailure(channelsResult) ? displayError(channelsResult.cause) : null

	if (workspaceId === null) {
		return (
			<div className="space-y-2 rounded-md border border-dashed border-border/60 p-3">
				<p className="text-xs text-muted-foreground">
					This destination&apos;s chat workspace isn&apos;t available. Create a new destination from
					a linked workspace instead.
				</p>
			</div>
		)
	}
	// The one failure with a fix the reader can make: a grant that predates channel access.
	const needsReinstall = failure?.code === "integration_not_connected"

	const storedChannelName =
		isEditing && form.chatChannelId.length === 0 && form.chatChannelName.length > 0
			? form.chatChannelName
			: null

	const label = (id: string): string => {
		const channel = channels.find((candidate) => candidate.id === id)
		return channel === undefined ? `#${form.chatChannelName || id}` : channelLabel(channel)
	}

	return (
		<Field className="items-stretch gap-1.5">
			<div className="flex items-center justify-between gap-2">
				<FieldLabel htmlFor="destination-chat-channel" className="text-xs">
					Channel
				</FieldLabel>
				<div className="flex min-w-0 items-center gap-1.5">
					{storedChannelName ? (
						<span className="truncate text-2xs text-muted-foreground">
							Currently{" "}
							<span className="font-medium text-foreground">#{storedChannelName}</span>
						</span>
					) : null}
					<RefreshButton
						type="button"
						size="xs"
						variant="ghost"
						className="-my-1 h-6 gap-1 px-1.5 text-2xs text-muted-foreground"
						onRefresh={refreshChannels}
						pending={channelsLoading}
					/>
				</div>
			</div>
			<Combobox
				value={form.chatChannelId || null}
				items={visibleChannelIds}
				filter={null}
				onInputValueChange={(value) => setChannelQuery(value)}
				itemToStringLabel={(value: string) => label(value)}
				onValueChange={(value) => {
					if (value == null) return
					const channel = channels.find((candidate) => candidate.id === value)
					onFormChange((current) => ({
						...current,
						chatChannelId: value,
						chatChannelName: channel?.name ?? current.chatChannelName,
					}))
				}}
			>
				<ComboboxInput
					id="destination-chat-channel"
					placeholder={channelsLoading ? "Loading channels…" : "Search channels…"}
					showClear
					className="w-full"
					startAddon={<MagnifierIcon />}
				/>
				<ComboboxContent>
					<ComboboxEmpty>
						{channelsLoading
							? "Loading channels…"
							: channels.length === 0
								? "No channels loaded yet."
								: "No matching channels."}
					</ComboboxEmpty>
					<ComboboxList>
						{visibleChannels.map((channel) => (
							<ComboboxItem key={channel.id} value={channel.id}>
								<span className="flex items-center gap-2">
									<span className="truncate">#{channel.name}</span>
									{channel.is_private ? (
										<span className="text-2xs text-muted-foreground">private</span>
									) : null}
								</span>
							</ComboboxItem>
						))}
					</ComboboxList>
					{truncated ? (
						<ComboboxStatus>
							{searchQuery.trim().length > 0
								? `Showing the closest ${CHANNEL_RESULT_LIMIT} matches — keep typing to narrow.`
								: `Showing ${CHANNEL_RESULT_LIMIT} of ${channels.length} channels — type to narrow.`}
						</ComboboxStatus>
					) : null}
				</ComboboxContent>
			</Combobox>
			{needsReinstall ? (
				<div className="flex flex-wrap items-center gap-2">
					<FieldError match className="text-2xs">
						{failure?.message}
					</FieldError>
					<Button
						type="button"
						size="xs"
						variant="outline"
						render={
							<Link
								to="/integrations"
								search={{ integration: chatIntegrationId(form.chatConnector) }}
								target="_blank"
								rel="noreferrer"
							/>
						}
					>
						Open {connectorName} integration
						<ArrowRightIcon />
					</Button>
				</div>
			) : failure !== null ? (
				<div className="flex items-center gap-2">
					<FieldError match className="text-2xs">
						{failure.type === "permission_error"
							? "Listing a workspace's channels is limited to org admins."
							: `Couldn't load ${connectorName} channels.`}
					</FieldError>
					{failure.type === "permission_error" ? null : (
						<Button type="button" size="xs" variant="ghost" onClick={refreshChannels}>
							Retry
						</Button>
					)}
				</div>
			) : channels.length === 0 && !channelsLoading ? (
				<p className="text-2xs text-muted-foreground">
					No channels returned. Make sure the Maple bot can see at least one channel, then hit
					Refresh.
				</p>
			) : null}
			<p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
				<CircleInfoIcon size={12} className="mt-0.5 shrink-0" />
				<span>
					Private channels are listed once the Maple bot has been added to them. Use Send test after
					saving to check it can post.
				</span>
			</p>
		</Field>
	)
}

function FieldHelper({ provider }: { provider: DestinationProvider }) {
	if (!provider.docsUrl) return null
	return (
		<a
			href={provider.docsUrl}
			target="_blank"
			rel="noreferrer"
			className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
		>
			{provider.docsLabel ?? "Docs"} ↗
		</a>
	)
}

/**
 * Turns "read a negative integer out of a raw `getUpdates` payload" into
 * picking a chat by name — the step where this setup otherwise fails.
 *
 * Only ever additive to the field: the manual input stays editable, because
 * Telegram keeps updates for about 24 hours and a bot with a webhook cannot be
 * inspected at all, so discovery legitimately comes back empty for setups that
 * are perfectly valid.
 */
function TelegramChatPicker({
	botToken,
	onSelect,
}: {
	botToken: string
	onSelect: (chatId: string) => void
}) {
	const [chats, setChats] = useState<ReadonlyArray<V2TelegramChat> | null>(null)
	const [error, setError] = useState<string | null>(null)
	const detect = useAtomSet(MapleApiV2AtomClient.mutation("alertDestinations", "telegramChats"), {
		mode: "promiseExit",
	})

	const tokenReady = isValidTelegramToken(botToken)

	const [runDetect, busy] = useAsyncAction(async () => {
		setError(null)
		setChats(null)
		const result = await detect({ payload: { bot_token: botToken.trim() } })
		if (Exit.isSuccess(result)) {
			const found = result.value.chats
			setChats(found)
			// One chat is the common case — the bot was just added to a single
			// group. Skip the pointless list of one and fill the field.
			if (found.length === 1 && found[0] !== undefined) onSelect(found[0].id)
			return
		}
		setError(displayError(result.cause).message)
	})

	return (
		<Field className="items-stretch gap-2">
			<div className="flex items-center justify-between gap-2">
				<FieldLabel htmlFor="destination-telegram-chat" className="text-xs">
					Chat ID
				</FieldLabel>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 px-2 text-2xs"
					disabled={!tokenReady}
					loading={busy}
					onClick={() => void runDetect()}
					title={
						tokenReady
							? undefined
							: "Enter the bot token first — detection reads the bot's chats."
					}
				>
					Detect chats
				</Button>
			</div>
			{error !== null ? (
				<FieldError match className="text-2xs">
					{error}
				</FieldError>
			) : null}
			{chats !== null && chats.length === 0 ? (
				<p className="text-2xs text-muted-foreground">
					No recent chats. Add the bot to the group or channel (or send it a message), then detect
					again. Telegram only keeps the last 24 hours.
				</p>
			) : null}
			{chats !== null && chats.length > 0 ? (
				<div className="space-y-1 rounded-md border border-border/60 p-1">
					{chats.map((chat) => (
						<button
							key={chat.id}
							type="button"
							onClick={() => onSelect(chat.id)}
							className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
						>
							<span className="truncate">{chat.title}</span>
							<span className="shrink-0 text-3xs text-muted-foreground">
								{TELEGRAM_CHAT_TYPE_LABELS[chat.type]}
							</span>
						</button>
					))}
				</div>
			) : null}
		</Field>
	)
}

export function DestinationDialog({
	open,
	onOpenChange,
	form,
	onFormChange,
	isEditing,
	saving,
	onSave,
	providerLocked = false,
	onUnlockProvider,
}: DestinationDialogProps) {
	// The connector's name and mark for a `chat` destination; the save button keeps the generic
	// provider's colours, whose ink is measured against its own accent.
	const provider = destinationProvider({ type: form.type, chatConnector: form.chatConnector })
	const buttonProvider = PROVIDERS[form.type]

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2.5">
						{isEditing ? (
							<ProviderLogo type={form.type} chatConnector={form.chatConnector} size={28} />
						) : null}
						{isEditing ? `Edit ${provider.label} destination` : "Add destination"}
					</DialogTitle>
					<DialogDescription>
						Where Maple sends a rule&apos;s notifications. Any rule can reuse it.
					</DialogDescription>
				</DialogHeader>

				{/* DialogContent is a viewport-capped flex column; the body scrolls so
				    the header and footer stay pinned when the form outgrows the screen. */}
				<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6">
					{!isEditing && (
						<div className="space-y-2">
							<Eyebrow variant="label" as="div">
								Send to
							</Eyebrow>
							{providerLocked ? (
								<Panel className="flex-row items-center justify-between gap-3 px-3 py-2">
									<span className="flex min-w-0 items-center gap-2.5">
										<ProviderLogo
											type={form.type}
											chatConnector={form.chatConnector}
											size={28}
										/>
										<span className="truncate text-sm font-medium">{provider.label}</span>
									</span>
									<Button
										type="button"
										variant="ghost"
										size="xs"
										onClick={onUnlockProvider}
									>
										Change
									</Button>
								</Panel>
							) : (
								<ProviderPicker form={form} onFormChange={onFormChange} />
							)}
						</div>
					)}

					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<Eyebrow variant="label" as="div">
								Connection
							</Eyebrow>
							<FieldHelper provider={provider} />
						</div>
						<Panel padded className="space-y-3">
							<Field className="items-stretch gap-1.5">
								<FieldLabel htmlFor="destination-name" className="text-xs">
									Name
									{isEditing ? null : (
										<span className="font-normal text-muted-foreground">optional</span>
									)}
								</FieldLabel>
								<Input
									id="destination-name"
									value={form.name}
									onChange={(event) =>
										onFormChange((current) => ({ ...current, name: event.target.value }))
									}
									placeholder={suggestedDestinationName(form) || "Production paging"}
								/>
							</Field>

							{form.type === "pagerduty" && (
								<Field className="items-stretch gap-1.5">
									<FieldLabel htmlFor="destination-integration" className="text-xs">
										Integration key
									</FieldLabel>
									<Input
										id="destination-integration"
										value={form.integrationKey}
										onChange={(event) =>
											onFormChange((current) => ({
												...current,
												integrationKey: event.target.value,
											}))
										}
										placeholder={
											isEditing
												? "Leave blank to keep current key"
												: "e.g. R0XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
										}
										className="font-mono text-xs"
									/>
									{form.integrationKey.trim().length > 0 &&
										!isValidPagerDutyKey(form.integrationKey) && (
											<FieldError match className="text-2xs">
												That isn't a routing key (must be 32 characters). A
												~20-character REST API token won't work — copy the Events API
												v2 integration key.
											</FieldError>
										)}
									<FieldDescription className="text-2xs">
										In PagerDuty: open the service → Integrations → add or select an{" "}
										<a
											href="https://maple.dev/docs/alerting/notification-destinations#pagerduty"
											target="_blank"
											rel="noreferrer"
											className="underline-offset-2 hover:text-foreground hover:underline"
										>
											Events API v2
										</a>{" "}
										integration → copy its Integration Key (32 characters). A REST API
										token won't work.
									</FieldDescription>
								</Field>
							)}

							{form.type === "discord" && (
								<Field className="items-stretch gap-1.5">
									<FieldLabel htmlFor="destination-discord-webhook" className="text-xs">
										Discord webhook URL
									</FieldLabel>
									<Input
										id="destination-discord-webhook"
										value={form.webhookUrl}
										onChange={(event) =>
											onFormChange((current) => ({
												...current,
												webhookUrl: event.target.value,
											}))
										}
										placeholder={
											isEditing
												? "Leave blank to keep current webhook"
												: "https://discord.com/api/webhooks/..."
										}
										className="font-mono text-xs"
									/>
									<FieldDescription className="text-2xs">
										In Discord: Channel settings → Integrations → Webhooks → New Webhook,
										then copy the URL.
									</FieldDescription>
								</Field>
							)}

							{form.type === "telegram" && (
								<>
									<Field className="items-stretch gap-1.5">
										<FieldLabel htmlFor="destination-telegram-token" className="text-xs">
											Bot token
										</FieldLabel>
										<Input
											id="destination-telegram-token"
											type="password"
											autoComplete="off"
											value={form.telegramBotToken}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													telegramBotToken: event.target.value,
												}))
											}
											placeholder={
												isEditing
													? "Leave blank to keep current token"
													: "123456789:ABC-DEF..."
											}
											className="font-mono text-xs"
										/>
										<FieldDescription className="text-2xs">
											In Telegram: message @BotFather, send{" "}
											<InlineCode>/newbot</InlineCode>, then copy the token it replies
											with.
										</FieldDescription>
									</Field>
									<div className="space-y-1.5">
										<TelegramChatPicker
											botToken={form.telegramBotToken}
											onSelect={(chatId) =>
												onFormChange((current) => ({
													...current,
													telegramChatId: chatId,
												}))
											}
										/>
										<Input
											id="destination-telegram-chat"
											value={form.telegramChatId}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													telegramChatId: event.target.value,
												}))
											}
											placeholder="-1001234567890 or @mychannel"
											className="font-mono text-xs"
										/>
										<p className="text-2xs text-muted-foreground">
											Add the bot to the chat, then hit <strong>Detect chats</strong> —
											or enter the id by hand. Maple checks the bot can reach it when
											you save.
										</p>
									</div>
								</>
							)}

							{form.type === "webhook" && (
								<>
									<Field className="items-stretch gap-1.5">
										<FieldLabel htmlFor="destination-url" className="text-xs">
											Webhook URL
										</FieldLabel>
										<Input
											id="destination-url"
											value={form.url}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													url: event.target.value,
												}))
											}
											placeholder={
												isEditing
													? "Leave blank to keep current URL"
													: "https://example.com/maple-alerts"
											}
											className="font-mono text-xs"
										/>
									</Field>
									<Field className="items-stretch gap-1.5">
										<FieldLabel htmlFor="destination-secret" className="text-xs">
											Signing secret
										</FieldLabel>
										<Input
											id="destination-secret"
											value={form.signingSecret}
											onChange={(event) =>
												onFormChange((current) => ({
													...current,
													signingSecret: event.target.value,
												}))
											}
											placeholder={
												isEditing
													? "Leave blank to keep current secret"
													: "Optional HMAC secret"
											}
											className="font-mono text-xs"
										/>
									</Field>
								</>
							)}

							{form.type === "email" &&
								(isClerkAuthEnabled ? (
									<EmailMemberPicker form={form} onFormChange={onFormChange} />
								) : (
									<p className="text-2xs text-muted-foreground">
										Email destinations target workspace members and require Clerk
										authentication, which is not enabled in this deployment.
									</p>
								))}

							{form.type === "chat" && (
								<ChatDestinationFields
									form={form}
									onFormChange={onFormChange}
									isEditing={isEditing}
								/>
							)}

							{form.type === "hazel-oauth" && (
								<HazelOAuthFields
									form={form}
									onFormChange={onFormChange}
									isEditing={isEditing}
								/>
							)}
						</Panel>
					</div>

					{isEditing ? (
						<div className="space-y-2">
							<Eyebrow variant="label" as="div">
								Delivery
							</Eyebrow>
							<SettingRow
								framed
								className="border-border/60 bg-card px-4 py-3"
								label="Enabled"
								description="Disabled destinations stay attached to rules but won't receive notifications."
								control={
									<Switch
										checked={form.enabled}
										onCheckedChange={(enabled) =>
											onFormChange((current) => ({ ...current, enabled }))
										}
									/>
								}
							/>
						</div>
					) : null}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={onSave}
						loading={saving}
						disabled={!isFormReady(form, isEditing)}
						style={{
							// `accentOn` is the ink the provider has measured against its own
							// accent — never assume a brand color is dark enough for white.
							background: buttonProvider.accent,
							borderColor: buttonProvider.accent,
							// The inline ink would otherwise show through the loading spinner.
							color: saving ? "transparent" : buttonProvider.accentOn,
						}}
					>
						{isEditing ? "Save changes" : `Add ${provider.label} destination`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
