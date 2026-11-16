import { formatDateInTimezone } from "@maple/ui/lib/timezone-format"
import type {
	EnterpriseSsoDocument,
	ScimDirectoryDocument,
	SsoConnectionDocument,
	SsoDomainDocument,
	SsoMappedRole,
	SsoProvider,
} from "@maple/domain/http"
import { ssoProtocolOf } from "@maple/domain/http"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import * as CopyButton from "@maple/views/ui/copy-button"
import { copyableField } from "@maple/views/ui/copyable-field"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import * as Field from "@maple/views/ui/field"
import {
	field,
	type FieldIds,
	fieldDescription,
	fieldGroupLabel,
	fieldLabel,
	input,
} from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import * as Menu from "@maple/views/ui/menu"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { dividedList, strip } from "@maple/views/ui/rule"
import { multiSegmentedSelect, segmentedSelect } from "@maple/views/ui/segmented-select"
import * as Select from "@maple/views/ui/select"
import * as SelectView from "@maple/views/ui/select-view"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import { switchRow } from "../../kit/switch-row"
import { adminOnlyNote, sectionNote, settingsSection, settingsSections } from "../../kit/settings-section"
import { type ConnectionDraft, type DraftField, type MappingDraft, Message, type Model } from "./model"
import {
	documentOf,
	isMappingsValid,
	mappingsProblem,
	hasUnmappedGroup,
	MAPPED_ROLES,
	mappingRows,
	normalizeDomain,
	PROVIDERS,
	requestOf,
	draftProblem,
	verifiedDomains,
} from "./update"

type H = HtmlBuilder<Message>

export const description = "Sign your team in through your identity provider and provision members over SCIM."

export const PROVIDER_LABELS = {
	saml_okta: "Okta (SAML)",
	saml_microsoft: "Microsoft Entra ID (SAML)",
	saml_google: "Google Workspace (SAML)",
	saml_custom: "Other SAML provider",
	oidc_github_enterprise: "GitHub Enterprise (OIDC)",
	oidc_gitlab: "GitLab (OIDC)",
	oidc_custom: "Other OIDC provider",
} as const satisfies Record<SsoProvider, string>

export const ROLE_LABELS = {
	"org:admin": "Admin",
	"org:engineer": "Engineer",
	"org:member": "Member",
	"org:analyst": "Analyst",
} as const satisfies Record<SsoMappedRole, string>

const PROVIDER_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = Arr.map(PROVIDERS, (provider) => ({
	_tag: "Item",
	item: { value: provider, label: PROVIDER_LABELS[provider] },
}))

const ROLE_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = Arr.map(MAPPED_ROLES, (role) => ({
	_tag: "Item",
	item: { value: role, label: ROLE_LABELS[role] },
}))

/** SSO set-up writes are open to admins on an org with the single sign-on add-on. */
const canEdit = (model: Model, document: EnterpriseSsoDocument): boolean =>
	model.canManage && document.ssoEntitled

/** SCIM set-up writes need the SCIM provisioning add-on. */
const canEditScim = (model: Model, document: EnterpriseSsoDocument): boolean =>
	model.canManage && document.scimEntitled

const ADD_ON_PRICE = "$100/month"

/** Turning things off or removing them stays open to admins after the plan lapses, as the API allows. */
const canExit = (model: Model): boolean => model.canManage

const isBusy = (model: Model): boolean => model.pending !== null

// Shared pieces

const copyStatus = (model: Model, key: string): CopyButton.CopyStatus => model.copies[key]?.status ?? "idle"

const copyValue = (h: H, model: Model, key: string, label: string, value: string): Html =>
	keyValue(
		h,
		{
			label,
			mono: true,
			copy: {
				status: copyStatus(model, key),
				onCopy: Message.GotCopyMessage({
					key,
					message: CopyButton.Message.ClickedCopy({ text: value }),
				}),
			},
		},
		[value],
	)

const plainValue = (h: H, label: string, value: string, mono = false): Html =>
	keyValue(h, { label, mono }, [value])

type SelectOptions = Readonly<{
	key: string
	value: string
	label: string
	entries: ReadonlyArray<SelectView.SelectEntry>
	ariaLabel?: string
	labelledBy?: string
	isDisabled?: boolean
}>

const selectControl = (h: H, model: Model, options: SelectOptions): Html => {
	const id = `sso-select-${options.key}`
	const base =
		model.selects[options.key] ??
		Select.init(id, {
			value: options.value,
			selectedIndex: SelectView.selectedIndexOf(options.entries, options.value),
		})
	return h.submodel({
		slotId: id,
		model: { ...base, value: options.value },
		view: SelectView.view,
		toParentMessage: (message) => Message.GotSelectMessage({ key: options.key, message }),
		viewInputs: {
			entries: options.entries,
			ariaLabel: options.ariaLabel,
			labelledBy: options.labelledBy,
			size: "sm",
			isDisabled: options.isDisabled ?? false,
			className: "w-full min-w-0",
			renderValue: () => [options.label],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})
}

// Not entitled

/** An add-on button for admins, a pointer to them for everyone else. */
const addOnAction = (h: H, model: Model, addOn: "sso" | "scim", label: string): Html =>
	model.canManage
		? button(
				h,
				{
					size: "sm",
					isLoading: model.isAttachingAddOn && model.addOn === addOn,
					isDisabled: model.isAttachingAddOn,
					attributes: [h.OnClick(Message.ClickedAddAddOn({ addOn }))],
				},
				[label],
			)
		: typography(h, { size: "sm", tone: "muted" }, ["Ask an admin to add it."])

const notEntitled = (h: H, model: Model): Html =>
	alert(h, { role: "status" }, [
		icon(h, "LockIcon"),
		alertTitle(h, [`Single sign-on is a ${ADD_ON_PRICE} add-on`]),
		alertDescription(h, [
			typography(h, { size: "sm", tone: "muted", as: "p", className: "font-prose" }, [
				"Sign in through Okta, Entra ID, Google Workspace or any SAML or OIDC provider. SCIM provisioning is a separate add-on once single sign-on is connected.",
			]),
			hstack(h, { gap: "2", className: "mt-3" }, [addOnAction(h, model, "sso", "Add single sign-on")]),
		]),
	])

// Domains

const domainStatus = (h: H, domain: SsoDomainDocument): Html =>
	domain.status === "verified"
		? badge(h, { variant: "done" }, ["Verified"])
		: badge(h, { variant: "muted" }, ["Pending"])

const domainRow = (h: H, model: Model, domain: SsoDomainDocument, isEditable: boolean): Html => {
	const menuId = `sso-domain-${domain.domain}`
	return tableRow(
		h,
		[
			tableCell(h, [typography(h, { size: "xs", weight: "medium", truncate: true }, [domain.domain])]),
			tableCell(h, [domainStatus(h, domain)], "w-28"),
			tableCell(
				h,
				// Removing stays open after the plan lapses, as the API allows; verifying needs the plan.
				canExit(model)
					? [
							rowActionsMenu(h, {
								slotId: menuId,
								model: model.domainMenus[menuId] ?? Menu.init(menuId),
								label: `Actions for ${domain.domain}`,
								entries: [
									...(domain.status === "verified" || !isEditable
										? []
										: [
												{
													_tag: "Item" as const,
													value: "verify",
													label: "Verify",
													icon: "CircleCheckIcon" as const,
												},
											]),
									{
										_tag: "Item",
										value: "remove",
										label: "Remove",
										icon: "TrashIcon",
										variant: "destructive",
									},
								],
								toParentMessage: (message) =>
									Message.GotDomainMenuMessage({ domain: domain.domain, message }),
							}),
						]
					: [],
				"w-12",
			),
		],
		undefined,
		[h.Key(domain.domain)],
	)
}

const pendingRecord = (h: H, model: Model, domain: SsoDomainDocument, isEditable: boolean): Html =>
	strip(h, { kind: "block", attributes: [h.Key(`record-${domain.domain}`)] }, [
		vstack(h, { gap: "3", align: "stretch" }, [
			hstack(h, { gap: "2", justify: "between" }, [
				typography(h, { size: "sm", weight: "medium" }, [`Verify ${domain.domain}`]),
				...(isEditable
					? [
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									isLoading: model.pending === "verifyDomain",
									isDisabled: isBusy(model),
									attributes: [
										h.OnClick(Message.ClickedVerifyDomain({ domain: domain.domain })),
									],
								},
								["Verify"],
							),
						]
					: []),
			]),
			typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
				"Add this TXT record at your DNS provider. DNS changes can take a few minutes to show.",
			]),
			keyValueList(h, { layout: "stacked" }, [
				copyValue(h, model, `record-name-${domain.domain}`, "Name", domain.recordName),
				copyValue(h, model, `record-value-${domain.domain}`, "Value", domain.recordValue),
			]),
		]),
	])

const domainsSection = (h: H, model: Model, document: EnterpriseSsoDocument): Html => {
	const isEditable = canEdit(model, document)
	const pending = Arr.filter(document.domains, (domain) => domain.status === "pending")
	return settingsSection(
		h,
		{
			id: "settings-sso-domains",
			title: "Domains",
			description: [
				"The email domains your identity provider signs in. Prove you own each one with a DNS record.",
			],
			padded: false,
			actions: isEditable
				? button(
						h,
						{
							size: "sm",
							variant: "outline",
							attributes: [h.OnClick(Message.ClickedAddDomain())],
						},
						[
							icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
							"Add domain",
						],
					)
				: undefined,
		},
		document.domains.length === 0
			? [sectionNote(h, "No domains yet. Add the domain your team's email addresses use.")]
			: [
					table(h, { className: "table-fixed" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Domain"]),
								tableHead(h, ["Status"], "w-28"),
								tableHead(h, [], "w-12"),
							]),
						]),
						tableBody(
							h,
							Arr.map(document.domains, (domain) => domainRow(h, model, domain, isEditable)),
						),
					]),
					...Arr.map(pending, (domain) => pendingRecord(h, model, domain, isEditable)),
				],
	)
}

// Identity provider

const spValues = (h: H, model: Model, connection: SsoConnectionDocument): ReadonlyArray<Html> =>
	Arr.flatMap(
		[
			["acs", "ACS URL", connection.acsUrl],
			["entity", "SP entity ID", connection.spEntityId],
			["metadata", "SP metadata URL", connection.spMetadataUrl],
			["redirect", "Redirect URI", connection.oidcRedirectUri],
		] as const,
		([key, label, value]) => (value === null ? [] : [copyValue(h, model, `sp-${key}`, label, value)]),
	)

const idpValues = (h: H, connection: SsoConnectionDocument): ReadonlyArray<Html> =>
	Arr.flatMap(
		[
			["Provider", PROVIDER_LABELS[connection.provider], false],
			["Domains", Arr.join(connection.domains, ", "), false],
			["Metadata URL", connection.idpMetadataUrl, true],
			["SSO URL", connection.idpSsoUrl, true],
			["Entity ID", connection.idpEntityId, true],
			[
				"Certificate expires",
				connection.idpCertificateExpiresAt === null
					? null
					: formatDateInTimezone(connection.idpCertificateExpiresAt, { timeZone: "UTC" }),
				false,
			],
			["Discovery URL", connection.oidcDiscoveryUrl, true],
			["Client ID", connection.oidcClientId, true],
		] as const,
		([label, value, mono]) => (value === null ? [] : [plainValue(h, label, value, mono)]),
	)

const connectionPanel = (
	h: H,
	model: Model,
	document: EnterpriseSsoDocument,
	connection: SsoConnectionDocument,
): ReadonlyArray<Html> => {
	const isEditable = canEdit(model, document)
	const isExitable = canExit(model)
	const sp = spValues(h, model, connection)
	return [
		vstack(h, { gap: "4", align: "stretch" }, [
			hstack(h, { gap: "2", justify: "between", wrap: true }, [
				hstack(h, { gap: "2" }, [
					typography(h, { size: "sm", weight: "medium" }, [connection.name]),
					connection.enforced
						? badge(h, { variant: "done" }, ["Required"])
						: badge(h, { variant: "muted" }, ["Off"]),
				]),
				...(isExitable
					? [
							hstack(h, { gap: "2" }, [
								...(isEditable
									? [
											button(
												h,
												{
													variant: "outline",
													size: "sm",
													isDisabled: isBusy(model),
													attributes: [h.OnClick(Message.ClickedEditConnection())],
												},
												["Edit"],
											),
										]
									: []),
								button(
									h,
									{
										variant: "destructive-outline",
										size: "sm",
										isDisabled: isBusy(model),
										attributes: [h.OnClick(Message.ClickedRemoveConnection())],
									},
									["Remove"],
								),
							]),
						]
					: []),
			]),
			...(sp.length === 0
				? []
				: [
						typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
							connection.protocol === "saml"
								? "Paste these into your identity provider. Its SAML response must send the email as mail; firstName and lastName are optional."
								: "Add this redirect URI to the OIDC application. Request the openid, email and profile scopes; the IdP must return the email and email_verified claims.",
						]),
						keyValueList(h, { layout: "stacked" }, sp),
					]),
			keyValueList(h, { layout: "split", divided: true }, idpValues(h, connection)),
		]),
		strip(h, { kind: "block", className: "-mx-4 -mb-4 mt-4" }, [
			switchRow(h, {
				id: "sso-enforce",
				label: "Require SSO",
				description: `Everyone with an email on ${Arr.join(connection.domains, ", ")} must sign in through ${connection.name}. Break-glass members can still sign in with an email code.`,
				isChecked: connection.enforced,
				// Without the plan, an enforced connection can still be relaxed, never enforced again.
				isDisabled: !(isEditable || (isExitable && connection.enforced)) || isBusy(model),
				onToggle: Message.ToggledEnforcement(),
			}),
		]),
	]
}

const noConnection = (h: H, model: Model, document: EnterpriseSsoDocument): Html => {
	const hasVerified = verifiedDomains(document).length > 0
	return empty(h, [
		emptyHeader(h, [
			emptyMedia(h, {}, [icon(h, "ShieldIcon", { size: 20 })]),
			emptyTitle(h, ["No identity provider"]),
			emptyDescription(h, [
				hasVerified
					? "Connect Okta, Entra ID, Google Workspace or any SAML or OIDC provider."
					: "Verify a domain first, then connect your identity provider.",
			]),
		]),
		...(canEdit(model, document)
			? [
					emptyContent(h, [
						button(
							h,
							{
								size: "sm",
								isDisabled: !hasVerified || isBusy(model),
								attributes: [h.OnClick(Message.ClickedConnect())],
							},
							["Connect identity provider"],
						),
					]),
				]
			: []),
	])
}

const connectionSection = (h: H, model: Model, document: EnterpriseSsoDocument): Html =>
	settingsSection(
		h,
		{
			id: "settings-sso-connection",
			title: "Identity provider",
			padded: document.connection !== null,
		},
		document.connection === null
			? [noConnection(h, model, document)]
			: connectionPanel(h, model, document, document.connection),
	)

// Break-glass

const memberLabel = (model: Model, userId: string, identifier: string | null): string =>
	Option.match(
		Option.flatMap(AsyncData.getData(model.members), (members) =>
			Arr.findFirst(members, (member) => member.userId === userId),
		),
		{ onNone: () => identifier ?? userId, onSome: (member) => member.name },
	)

const bypassSection = (h: H, model: Model, document: EnterpriseSsoDocument): Html => {
	const isEditable = canEdit(model, document)
	return settingsSection(
		h,
		{
			id: "settings-sso-bypass",
			title: "Break-glass access",
			description: [
				"These members can sign in with an email code when the identity provider is down. Only members with a verified email on the SSO domains can be added.",
			],
			padded: false,
			// Nobody qualifies before a connection names the SSO domains.
			actions:
				isEditable && document.connection !== null
					? button(
							h,
							{
								size: "sm",
								variant: "outline",
								isDisabled: isBusy(model),
								attributes: [h.OnClick(Message.ClickedAddBypass())],
							},
							["Add member"],
						)
					: undefined,
		},
		document.bypassUsers.length === 0
			? [sectionNote(h, "No break-glass members. Add one before you require SSO.")]
			: [
					dividedList(
						h,
						{ as: "ul", bordered: false },
						Arr.map(document.bypassUsers, (user) =>
							h.li(
								[h.Key(user.userId)],
								[
									hstack(h, { gap: "2", justify: "between", className: "px-4 py-2.5" }, [
										vstack(h, { gap: "0.5", align: "start", className: "min-w-0" }, [
											typography(h, { size: "sm", weight: "medium", truncate: true }, [
												memberLabel(model, user.userId, user.identifier),
											]),
											...(user.identifier === null
												? []
												: [
														typography(
															h,
															{ size: "xs", tone: "muted", truncate: true },
															[user.identifier],
														),
													]),
										]),
										...(canExit(model)
											? [
													iconButton(
														h,
														{
															label: `Remove break-glass access for ${memberLabel(model, user.userId, user.identifier)}`,
															isDisabled: isBusy(model),
															attributes: [
																h.OnClick(
																	Message.ClickedRemoveBypass({
																		userId: user.userId,
																	}),
																),
															],
														},
														[icon(h, "TrashIcon")],
													),
												]
											: []),
									]),
								],
							),
						),
					),
				],
	)
}

// SCIM

const directoryPanel = (
	h: H,
	model: Model,
	document: EnterpriseSsoDocument,
	directory: ScimDirectoryDocument,
): ReadonlyArray<Html> => {
	const isEditable = canEditScim(model, document)
	// Pausing and removing stay open without the plan; resuming and rotating need it.
	const canTogglePause = directory.paused ? isEditable : canExit(model)
	return [
		vstack(h, { gap: "4", align: "stretch" }, [
			hstack(h, { gap: "2", justify: "between", wrap: true }, [
				hstack(h, { gap: "2" }, [
					typography(h, { size: "sm", weight: "medium" }, ["SCIM 2.0"]),
					directory.paused
						? badge(h, { variant: "warn" }, ["Paused"])
						: badge(h, { variant: "done" }, ["Active"]),
				]),
				...(canExit(model)
					? [
							hstack(h, { gap: "2", wrap: true }, [
								...(canTogglePause
									? [
											button(
												h,
												{
													variant: "outline",
													size: "sm",
													isLoading:
														model.pending === "pause" ||
														model.pending === "resume",
													isDisabled: isBusy(model),
													attributes: [h.OnClick(Message.ClickedTogglePaused())],
												},
												[directory.paused ? "Resume" : "Pause"],
											),
										]
									: []),
								...(isEditable
									? [
											button(
												h,
												{
													variant: "outline",
													size: "sm",
													isDisabled: isBusy(model),
													attributes: [h.OnClick(Message.ClickedRotateToken())],
												},
												["Rotate token"],
											),
										]
									: []),
								button(
									h,
									{
										variant: "destructive-outline",
										size: "sm",
										isDisabled: isBusy(model),
										attributes: [h.OnClick(Message.ClickedRemoveDirectory())],
									},
									["Remove"],
								),
							]),
						]
					: []),
			]),
			keyValueList(h, { layout: "stacked" }, [
				copyValue(h, model, "scim-endpoint", "Endpoint URL", directory.endpointUrl),
			]),
			typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
				directory.paused
					? "Your identity provider's pushes are refused while provisioning is paused."
					: "Your identity provider creates, updates and removes members through this endpoint.",
			]),
		]),
	]
}

const noDirectory = (h: H, model: Model, document: EnterpriseSsoDocument): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, {}, [icon(h, "UsersIcon", { size: 20 })]),
			emptyTitle(h, ["SCIM is not set up"]),
			emptyDescription(h, [
				document.scimEntitled
					? "Let your identity provider add and remove members, and set their role from its groups."
					: `Let your identity provider add and remove members, and set their role from its groups. SCIM provisioning is a ${ADD_ON_PRICE} add-on.`,
			]),
		]),
		...(canEditScim(model, document)
			? [
					emptyContent(h, [
						button(
							h,
							{
								size: "sm",
								isLoading: model.pending === "createDirectory",
								isDisabled: isBusy(model),
								attributes: [h.OnClick(Message.ClickedSetUpScim())],
							},
							["Set up SCIM"],
						),
					]),
				]
			: document.scimEntitled
				? []
				: [emptyContent(h, [addOnAction(h, model, "scim", "Add SCIM provisioning")])]),
	])

const scimSection = (h: H, model: Model, document: EnterpriseSsoDocument): Html =>
	settingsSection(
		h,
		{ id: "settings-sso-scim", title: "SCIM provisioning", padded: document.directory !== null },
		document.directory === null
			? [noDirectory(h, model, document)]
			: directoryPanel(h, model, document, document.directory),
	)

const groupLabel = (document: EnterpriseSsoDocument, groupId: string): string => {
	if (groupId === "") return "Pick a group"
	return Option.getOrElse(
		Option.orElse(
			Option.map(
				Arr.findFirst(document.groups, (group) => group.groupId === groupId),
				(group) => group.displayName,
			),
			() =>
				Option.flatMap(
					Arr.findFirst(document.roleMappings, (mapping) => mapping.groupId === groupId),
					(mapping) => Option.fromNullishOr(mapping.groupName),
				),
		),
		() => groupId,
	)
}

const groupEntries = (
	document: EnterpriseSsoDocument,
	row: MappingDraft,
): ReadonlyArray<SelectView.SelectEntry> => {
	const known = Arr.map(document.groups, (group): SelectView.SelectEntry => ({
		_tag: "Item",
		item: { value: group.groupId, label: group.displayName },
	}))
	// A mapped group the IdP no longer pushes still shows, so the row reads what it holds.
	const isKnown = row.groupId === "" || Arr.some(document.groups, (group) => group.groupId === row.groupId)
	return isKnown
		? known
		: [...known, { _tag: "Item", item: { value: row.groupId, label: groupLabel(document, row.groupId) } }]
}

const mappingRow = (
	h: H,
	model: Model,
	document: EnterpriseSsoDocument,
	row: MappingDraft,
	index: number,
	count: number,
	isEditable: boolean,
): Html => {
	// Names each row's buttons, so a screen reader can tell the rows apart.
	const rowName = row.groupId === "" ? `row ${index + 1}` : groupLabel(document, row.groupId)
	return h.li(
		[h.Key(row.key)],
		[
			// Wraps on narrow screens: the group picker keeps 12rem, role and buttons drop below it.
			hstack(h, { gap: "2", wrap: true, className: "px-4 py-2.5" }, [
				typography(h, { size: "xs", tone: "muted", numeric: true, className: "w-5 shrink-0" }, [
					String(index + 1),
				]),
				h.div(
					[h.Class("min-w-48 flex-1")],
					[
						selectControl(h, model, {
							key: `group-${row.key}`,
							value: row.groupId,
							label: groupLabel(document, row.groupId),
							entries: groupEntries(document, row),
							ariaLabel: `Group for mapping ${index + 1}`,
							isDisabled: !isEditable || isBusy(model),
						}),
					],
				),
				h.div(
					[h.Class("w-36 shrink-0")],
					[
						selectControl(h, model, {
							key: `role-${row.key}`,
							value: row.role,
							label: ROLE_LABELS[row.role],
							entries: ROLE_ENTRIES,
							ariaLabel: `Role for mapping ${index + 1}`,
							isDisabled: !isEditable || isBusy(model),
						}),
					],
				),
				...(isEditable
					? [
							iconButton(
								h,
								{
									label: `Move ${rowName} up`,
									isDisabled: index === 0 || isBusy(model),
									attributes: [
										h.OnClick(Message.ClickedMoveMapping({ key: row.key, by: -1 })),
									],
								},
								[icon(h, "ArrowUpIcon")],
							),
							iconButton(
								h,
								{
									label: `Move ${rowName} down`,
									isDisabled: index === count - 1 || isBusy(model),
									attributes: [
										h.OnClick(Message.ClickedMoveMapping({ key: row.key, by: 1 })),
									],
								},
								[icon(h, "ArrowDownIcon")],
							),
							iconButton(
								h,
								{
									label: `Remove mapping for ${rowName}`,
									isDisabled: isBusy(model),
									attributes: [h.OnClick(Message.ClickedRemoveMapping({ key: row.key }))],
								},
								[icon(h, "TrashIcon")],
							),
						]
					: []),
			]),
		],
	)
}

const mappingsSection = (h: H, model: Model, document: EnterpriseSsoDocument): Html => {
	const isEditable = canEditScim(model, document)
	const rows = mappingRows(model)
	const isDirty = model.mappings !== null
	const hasGroups = document.groups.length > 0
	const problem = mappingsProblem(rows)
	return settingsSection(
		h,
		{
			id: "settings-sso-mappings",
			title: "Role mapping",
			description: [
				"Members get the role of the first group that matches, top to bottom. Members in no mapped group join as members. A change applies the next time your identity provider pushes the group (in Okta, Push Groups then Push now).",
			],
			padded: false,
		},
		[
			...(hasGroups
				? []
				: [sectionNote(h, "Groups appear here after your identity provider pushes them over SCIM.")]),
			...(rows.length === 0
				? hasGroups
					? [sectionNote(h, "No mappings yet.")]
					: []
				: [
						dividedList(
							h,
							{ as: "ol", bordered: false },
							Arr.map(rows, (row, index) =>
								mappingRow(h, model, document, row, index, rows.length, isEditable),
							),
						),
					]),
			...(isEditable && (hasGroups || isDirty)
				? [
						strip(h, { kind: "foot" }, [
							hstack(h, { gap: "2", justify: "between" }, [
								button(
									h,
									{
										variant: "ghost",
										size: "sm",
										isDisabled: !hasUnmappedGroup(document, rows) || isBusy(model),
										attributes: [h.OnClick(Message.ClickedAddMapping())],
									},
									[
										icon(h, "PlusIcon", {
											attributes: [h.DataAttribute("icon", "inline-start")],
										}),
										"Add mapping",
									],
								),
								hstack(h, { gap: "2" }, [
									// A greyed-out Save says why.
									...(isDirty && problem !== null
										? [typography(h, { size: "xs", tone: "muted" }, [problem])]
										: []),
									...(isDirty
										? [
												button(
													h,
													{
														variant: "ghost",
														size: "sm",
														isDisabled: isBusy(model),
														attributes: [
															h.OnClick(Message.ClickedDiscardMappings()),
														],
													},
													["Discard"],
												),
											]
										: []),
									button(
										h,
										{
											size: "sm",
											isLoading: model.pending === "saveMappings",
											isDisabled: !isDirty || !isMappingsValid(rows) || isBusy(model),
											attributes: [h.OnClick(Message.ClickedSaveMappings())],
										},
										["Save"],
									),
								]),
							]),
						]),
					]
				: []),
		],
	)
}

// Dialogs

const DOMAIN_IDS: FieldIds = { control: "sso-domain", label: "sso-domain-label", error: "sso-domain-error" }

const addDomainDialog = (h: H, model: Model): Html => {
	const state = Field.stateOf(model.domainField, false)
	return formDialog(h, {
		slotId: "sso-domain-add",
		model: model.addDomainDialog,
		toParentMessage: (message) => Message.GotAddDomainDialogMessage({ message }),
		title: "Add domain",
		description: "Next you'll publish a TXT record on it to prove your team owns it.",
		onSubmit: Message.SubmittedAddDomain(),
		submitLabel: "Add domain",
		isPending: model.pending === "addDomain",
		isSubmitDisabled: normalizeDomain(model.domainField.value) === "",
		fields: [
			field(h, { state }, [
				fieldLabel(h, { ids: DOMAIN_IDS, state }, "Domain"),
				input(h, {
					ids: DOMAIN_IDS,
					state,
					attributes: [
						h.Placeholder("acme.com"),
						h.Autocomplete("off"),
						...Field.controlAttributes(h, model.domainField, (message) =>
							Message.GotDomainFieldMessage({ message }),
						),
					],
				}),
			]),
		],
	})
}

const draftIds = (key: DraftField): FieldIds => ({
	control: `sso-draft-${key}`,
	label: `sso-draft-${key}-label`,
	error: `sso-draft-${key}-error`,
	description: `sso-draft-${key}-hint`,
})

const draftInput = (
	h: H,
	draft: ConnectionDraft,
	key: DraftField,
	label: string,
	options: Readonly<{ placeholder?: string; hint?: string; isSecret?: boolean }> = {},
): Html => {
	const model = draft.fields[key] ?? Field.init()
	const ids = draftIds(key)
	const state = Field.stateOf(model, false)
	return field(h, { state }, [
		fieldLabel(h, { ids, state }, label),
		input(h, {
			ids,
			state,
			attributes: [
				h.Autocomplete("off"),
				...(options.isSecret === true ? [h.Type("password")] : []),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				...Field.controlAttributes(h, model, (message) =>
					Message.GotDraftFieldMessage({ field: key, message }),
				),
			],
		}),
		...(options.hint === undefined ? [] : [fieldDescription(h, { ids, state }, options.hint)]),
	])
}

const certificateInput = (h: H, draft: ConnectionDraft): Html => {
	const model = draft.fields.certificate ?? Field.init()
	const ids = draftIds("certificate")
	const state = Field.stateOf(model, false)
	return field(h, { state }, [
		fieldLabel(h, { ids, state }, "Signing certificate"),
		textarea(h, {
			id: ids.control,
			controlClassName: "font-mono text-xs",
			attributes: [
				h.Rows(5),
				h.Placeholder("-----BEGIN CERTIFICATE-----"),
				h.AriaLabelledBy(ids.label),
				// The edit-mode hint below is the only description, so it is linked only when shown.
				...(draft.mode === "edit" && ids.description !== undefined
					? [h.AriaDescribedBy(ids.description)]
					: []),
				h.Value(model.value),
				h.OnInput((value) =>
					Message.GotDraftFieldMessage({
						field: "certificate",
						message: Field.Message.ChangedValue({ value }),
					}),
				),
			],
		}),
		...(draft.mode === "edit"
			? [fieldDescription(h, { ids, state }, "Leave empty to keep the current certificate.")]
			: []),
	])
}

const protocolFields = (h: H, draft: ConnectionDraft): ReadonlyArray<Html> => {
	if (ssoProtocolOf(draft.provider) === "oidc")
		return [
			draftInput(h, draft, "discoveryUrl", "Discovery URL", {
				placeholder: "https://idp.example.com/.well-known/openid-configuration",
			}),
			draftInput(h, draft, "clientId", "Client ID"),
			draftInput(h, draft, "clientSecret", "Client secret", {
				isSecret: true,
				...(draft.mode === "edit" && { hint: "Leave empty to keep the current secret." }),
			}),
		]
	return [
		vstack(h, { gap: "2", align: "stretch" }, [
			fieldGroupLabel(h, {}, "SAML settings"),
			segmentedSelect(h, {
				options: [
					{ value: "metadata", label: "Metadata URL" },
					{ value: "manual", label: "Enter manually" },
				],
				value: draft.samlMode,
				onChange: (mode) => Message.PickedSamlMode({ mode }),
				ariaLabel: "How to configure SAML",
				size: "sm",
			}),
		]),
		...(draft.samlMode === "metadata"
			? [
					draftInput(h, draft, "metadataUrl", "IdP metadata URL", {
						placeholder: "https://idp.example.com/metadata.xml",
					}),
				]
			: [
					draftInput(h, draft, "ssoUrl", "IdP SSO URL", {
						placeholder: "https://idp.example.com/sso",
					}),
					draftInput(h, draft, "entityId", "IdP entity ID"),
					certificateInput(h, draft),
				]),
	]
}

const footerReason = (h: H, reason: string | null): { readonly footerStart?: Html } =>
	reason === null ? {} : { footerStart: typography(h, { size: "xs", tone: "muted" }, [reason]) }

const connectionDialog = (h: H, model: Model, document: EnterpriseSsoDocument | null): Html => {
	const draft = model.draft
	const verified = document === null ? [] : verifiedDomains(document)
	const isEdit = draft?.mode === "edit"
	return formDialog(h, {
		slotId: "sso-connection",
		model: model.connectionDialog,
		toParentMessage: (message) => Message.GotConnectionDialogMessage({ message }),
		title: isEdit ? "Edit identity provider" : "Connect identity provider",
		description:
			"Nobody signs in through it until you require SSO. Then everyone on the chosen domains must.",
		onSubmit: Message.SubmittedConnection(),
		submitLabel: isEdit ? "Save" : "Connect",
		isPending: model.pending === "createConnection" || model.pending === "updateConnection",
		isSubmitDisabled: draft === null || Option.isNone(requestOf(draft)),
		// A disabled submit says why, so the admin knows what to fix.
		...footerReason(h, draft === null ? null : draftProblem(draft)),
		fields:
			draft === null
				? []
				: [
						field(h, { state: Field.stateOf(Field.init(draft.provider), false) }, [
							fieldGroupLabel(h, { attributes: [h.Id("sso-provider-label")] }, "Provider"),
							selectControl(h, model, {
								key: "provider",
								value: draft.provider,
								label: PROVIDER_LABELS[draft.provider],
								entries: PROVIDER_ENTRIES,
								labelledBy: "sso-provider-label",
								isDisabled: isEdit,
							}),
						]),
						draftInput(h, draft, "name", "Name", { placeholder: "Okta" }),
						vstack(h, { gap: "2", align: "stretch" }, [
							fieldGroupLabel(h, {}, "Domains"),
							verified.length === 0
								? adminOnlyNote(h, ["Verify a domain before connecting."])
								: multiSegmentedSelect(h, {
										options: Arr.map(verified, (domain) => ({
											value: domain,
											label: domain,
											ariaLabel: domain,
										})),
										value: draft.domains,
										onToggle: (domain) => Message.ToggledDraftDomain({ domain }),
										ariaLabel: "Domains",
										size: "sm",
										className: "flex-wrap",
									}),
						]),
						...protocolFields(h, draft),
					],
	})
}

const tokenDialog = (h: H, model: Model): Html => {
	const id = model.tokenDialog.id
	const token = model.issuedToken ?? ""
	return h.submodel({
		slotId: "sso-token",
		model: model.tokenDialog,
		view: DialogView.view,
		toParentMessage: (message) => Message.GotTokenDialogMessage({ message }),
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", id, "SCIM token"),
					DialogView.dialogDescription(
						h,
						"dialog",
						id,
						"Paste this token into your identity provider's SCIM settings with the endpoint URL.",
					),
				]),
				DialogView.dialogPanel(h, "dialog", id, [
					vstack(h, { gap: "3", align: "stretch" }, [
						copyableField(h, {
							id: "sso-scim-token",
							label: "Token",
							value: token,
							copyLabel: "SCIM token",
							copy: model.copies["token"] ?? CopyButton.init(),
							toCopyMessage: (message) => Message.GotCopyMessage({ key: "token", message }),
						}),
						alert(h, { variant: "warn", size: "sm", role: "status" }, [
							icon(h, "AlertWarningIcon"),
							alertDescription(h, [
								"You will not see this token again. Rotate it to get a new one if you lose it.",
							]),
						]),
					]),
				]),
				DialogView.dialogFooter(h, "dialog", [button(h, { attributes: close }, ["Done"])]),
			],
		},
	})
}

const bypassEntries = (
	model: Model,
	document: EnterpriseSsoDocument,
): ReadonlyArray<SelectView.SelectEntry> =>
	Arr.flatMap(
		AsyncData.getOrElse(model.members, () => []),
		(member): ReadonlyArray<SelectView.SelectEntry> =>
			// Any verified email can qualify, not just the one shown, so the API decides and says why.
			Arr.some(document.bypassUsers, (user) => user.userId === member.userId)
				? []
				: [
						{
							_tag: "Item",
							item: {
								value: member.userId,
								label:
									member.name === member.identifier
										? member.name
										: `${member.name} (${member.identifier})`,
							},
						},
					],
	)

const bypassDialog = (h: H, model: Model, document: EnterpriseSsoDocument | null): Html => {
	const entries = document === null ? [] : bypassEntries(model, document)
	const picked = Option.getOrNull(
		Arr.findFirst(SelectView.optionsOf(entries), (option) => option.value === model.bypassPick),
	)
	return formDialog(h, {
		slotId: "sso-bypass-add",
		model: model.bypassDialog,
		toParentMessage: (message) => Message.GotBypassDialogMessage({ message }),
		title: "Add break-glass member",
		description:
			"Pick a member with an email on the SSO domains who can sign in with an email code if the identity provider is down.",
		onSubmit: Message.SubmittedBypass(),
		submitLabel: "Add member",
		isPending: model.pending === "addBypass",
		isSubmitDisabled: picked === null,
		fields: [
			vstack(h, { gap: "2", align: "stretch" }, [
				fieldGroupLabel(h, { attributes: [h.Id("sso-bypass-label")] }, "Member"),
				AsyncData.isFailure(model.members)
					? adminOnlyNote(h, ["Couldn't load members. Close this and try again."])
					: AsyncData.isSuccess(model.members) || AsyncData.isRefreshing(model.members)
						? entries.length === 0
							? adminOnlyNote(h, ["Every member already has break-glass access."])
							: selectControl(h, model, {
									key: "bypass",
									value: model.bypassPick ?? "",
									label: picked?.label ?? "Pick a member",
									entries,
									labelledBy: "sso-bypass-label",
								})
						: skeleton(h, "h-8 w-full"),
			]),
		],
	})
}

const dialogs = (h: H, model: Model, document: EnterpriseSsoDocument | null): ReadonlyArray<Html> => {
	const connection = document?.connection ?? null
	return [
		addDomainDialog(h, model),
		confirmDialog(h, {
			slotId: "sso-domain-remove",
			model: model.removeDomainDialog,
			toParentMessage: (message) => Message.GotRemoveDomainDialogMessage({ message }),
			title: `Remove ${model.removingDomain ?? "domain"}?`,
			description: "Members on this domain can no longer sign in through your identity provider.",
			confirmLabel: "Remove domain",
			isPending: model.pending === "removeDomain",
			onConfirm: Message.ClickedConfirmRemoveDomain(),
		}),
		connectionDialog(h, model, document),
		confirmDialog(h, {
			slotId: "sso-enforce",
			model: model.enforceDialog,
			toParentMessage: (message) => Message.GotEnforceDialogMessage({ message }),
			title: "Require SSO?",
			description: [
				`Everyone with an email on ${Arr.join(connection?.domains ?? [], ", ")} must sign in through ${connection?.name ?? "your identity provider"}. Passwords and other sign-in methods stop working for them.`,
				...(document !== null && document.bypassUsers.length === 0
					? [
							" Add a break-glass member first, so you keep access if the identity provider is down.",
						]
					: []),
			],
			confirmLabel: "Require SSO",
			tone: "default",
			isPending: model.pending === "enforce",
			onConfirm: Message.ClickedConfirmEnforce(),
		}),
		confirmDialog(h, {
			slotId: "sso-connection-remove",
			model: model.removeConnectionDialog,
			toParentMessage: (message) => Message.GotRemoveConnectionDialogMessage({ message }),
			title: "Remove identity provider?",
			description:
				"Members go back to signing in with their own email and password. SCIM provisioning stops too.",
			confirmLabel: "Remove",
			isPending: model.pending === "deleteConnection",
			onConfirm: Message.ClickedConfirmRemoveConnection(),
		}),
		bypassDialog(h, model, document),
		confirmDialog(h, {
			slotId: "sso-bypass-remove",
			model: model.removeBypassDialog,
			toParentMessage: (message) => Message.GotRemoveBypassDialogMessage({ message }),
			title: "Remove break-glass access?",
			description:
				"This member will have to sign in through the identity provider when SSO is required.",
			confirmLabel: "Remove",
			isPending: model.pending === "removeBypass",
			onConfirm: Message.ClickedConfirmRemoveBypass(),
		}),
		confirmDialog(h, {
			slotId: "sso-token-rotate",
			model: model.rotateDialog,
			toParentMessage: (message) => Message.GotRotateDialogMessage({ message }),
			title: "Rotate the SCIM token?",
			description:
				"The current token keeps working for a short grace period, then stops. Paste the new one into your identity provider before then.",
			confirmLabel: "Rotate token",
			isPending: model.pending === "rotateToken",
			onConfirm: Message.ClickedConfirmRotate(),
		}),
		tokenDialog(h, model),
		confirmDialog(h, {
			slotId: "sso-add-on",
			model: model.addOnDialog,
			toParentMessage: (message) => Message.GotAddOnDialogMessage({ message }),
			tone: "default",
			title:
				model.addOn === "scim"
					? `Add SCIM provisioning for ${ADD_ON_PRICE}?`
					: `Add single sign-on for ${ADD_ON_PRICE}?`,
			description:
				"If your organization has a payment method on file, the add-on is attached right away and billed with your plan. Otherwise you continue to checkout.",
			confirmLabel: "Add to plan",
			onConfirm: Message.ClickedConfirmAddOn(),
			isPending: model.isAttachingAddOn,
		}),
		confirmDialog(h, {
			slotId: "sso-directory-remove",
			model: model.removeDirectoryDialog,
			toParentMessage: (message) => Message.GotRemoveDirectoryDialogMessage({ message }),
			title: "Remove SCIM provisioning?",
			description:
				"Your identity provider stops adding and removing members. Members it already added keep their access.",
			confirmLabel: "Remove",
			isPending: model.pending === "deleteDirectory",
			onConfirm: Message.ClickedConfirmRemoveDirectory(),
		}),
	]
}

const loaded = (
	h: H,
	model: Model,
	document: EnterpriseSsoDocument,
	isKnownMember: boolean,
): ReadonlyArray<Html> => {
	const hasState = document.domains.length > 0 || document.connection !== null
	if (!document.ssoEntitled && !hasState) return [notEntitled(h, model)]
	return [
		...(document.ssoEntitled ? [] : [notEntitled(h, model)]),
		// While the role is unknown the page banner speaks; nothing claims the viewer is not an admin.
		...(model.canManage || !isKnownMember
			? []
			: [adminOnlyNote(h, ["Only admins can change SSO and SCIM settings."])]),
		domainsSection(h, model, document),
		connectionSection(h, model, document),
		bypassSection(h, model, document),
		...(document.connection === null
			? []
			: [
					scimSection(h, model, document),
					...(document.directory === null ? [] : [mappingsSection(h, model, document)]),
				]),
	]
}

const loadingSkeleton = (h: H): Html =>
	vstack(h, { gap: "3", align: "stretch" }, [skeleton(h, "h-32 w-full"), skeleton(h, "h-40 w-full")])

export const view = Submodel.defineView<Model, Message, Readonly<{ isKnownMember: boolean }>>(
	(model, inputs, h) =>
		settingsSections(h, [
			...AsyncData.match(model.document, {
				onIdle: () => [loadingSkeleton(h)],
				onLoading: () => [loadingSkeleton(h)],
				onFailure: (failure) => [
					errorState(h, {
						failure,
						title: "Couldn't load SSO settings",
						variant: "row",
						onRetry: Message.ClickedRetry(),
					}),
				],
				onSuccess: (document) => loaded(h, model, document, inputs.isKnownMember),
				onRefreshing: (document) => loaded(h, model, document, inputs.isKnownMember),
				onStale: ({ data }) => loaded(h, model, data, inputs.isKnownMember),
			}),
			...dialogs(h, model, documentOf(model)),
		]),
)
