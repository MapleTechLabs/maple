import { useOrganization } from "@clerk/clerk-react"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"

import {
	Select,
	SelectContent,
	SelectGroup,
	SelectGroupLabel,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"

import { useApiKeysList } from "@/hooks/use-api-keys"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

import { memberDisplayName } from "./admin-only-notice"

interface PersonOption {
	readonly value: string
	readonly label: string
}

const ANYONE = "anyone"

function useMemberOptions(): ReadonlyArray<PersonOption> {
	const { memberships } = useOrganization({ memberships: { pageSize: 100 } })
	return (memberships?.data ?? []).flatMap((membership) => {
		const user = membership.publicUserData
		const userId = user?.userId
		if (userId === undefined) return []
		return [{ value: userId, label: memberDisplayName(user) ?? userId }]
	})
}

/** "Anyone", or one member or API key: the audit log's `actor_id` filter. */
export function AuditLogPersonFilter(props: {
	value: string | undefined
	onChange: (actorId: string | undefined) => void
}) {
	// Self-hosted runs without Clerk: there is no member directory to list.
	if (!isClerkAuthEnabled) return <PersonSelect {...props} members={[]} />
	return <PersonFilterWithMembers {...props} />
}

function PersonFilterWithMembers(props: {
	value: string | undefined
	onChange: (actorId: string | undefined) => void
}) {
	return <PersonSelect {...props} members={useMemberOptions()} />
}

function PersonSelect({
	value,
	onChange,
	members,
}: {
	value: string | undefined
	onChange: (actorId: string | undefined) => void
	members: ReadonlyArray<PersonOption>
}) {
	const { keys } = useApiKeysList()
	// Audit rows name a key by its public `key_…` id; the synced rows carry the internal one.
	const keyOptions: ReadonlyArray<PersonOption> = keys.map((key) => ({
		value: encodePublicId(PublicIdPrefixes.apiKey, key.id),
		label: key.name,
	}))
	const selected = [...members, ...keyOptions].find((option) => option.value === value)
	const selectedLabel = value === undefined ? "Anyone" : (selected?.label ?? value)

	return (
		<Select
			value={value ?? ANYONE}
			onValueChange={(next) => onChange(next === null || next === ANYONE ? undefined : next)}
		>
			<SelectTrigger size="sm" className="w-auto min-w-40 max-w-64" aria-label="Person">
				<SelectValue>
					<span className="truncate">{selectedLabel}</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ANYONE}>Anyone</SelectItem>
				{members.length > 0 && (
					<SelectGroup>
						<SelectGroupLabel>Members</SelectGroupLabel>
						{members.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectGroup>
				)}
				{keyOptions.length > 0 && (
					<SelectGroup>
						<SelectGroupLabel>API keys</SelectGroupLabel>
						{keyOptions.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectGroup>
				)}
			</SelectContent>
		</Select>
	)
}
