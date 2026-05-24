import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getResourceAttributeKeysResultAtom,
	getSpanAttributeKeysResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import {
	Autocomplete,
	AutocompleteCollection,
	AutocompleteEmpty,
	AutocompleteInput,
	AutocompleteItem,
	AutocompleteList,
	AutocompletePopup,
	AutocompleteStatus,
} from "@maple/ui/components/ui/autocomplete"
import { useMemo } from "react"

export function AttributeKeyAutocomplete({
	id,
	value,
	onValueChange,
	placeholder,
	scope,
}: {
	id: string
	value: string
	onValueChange: (value: string) => void
	placeholder?: string
	scope: "span" | "resource"
}) {
	// Subscribe to both atoms unconditionally (Rules of Hooks); pick by scope below.
	const spanKeysResult = useAtomValue(getSpanAttributeKeysResultAtom({ data: {} }))
	const resourceKeysResult = useAtomValue(getResourceAttributeKeysResultAtom({ data: {} }))

	const result = scope === "span" ? spanKeysResult : resourceKeysResult

	const keys = useMemo(
		() =>
			Result.builder(result)
				.onSuccess((r) => r.data.map((row) => row.attributeKey))
				.orElse(() => [] as string[]),
		[result],
	)

	return (
		<Autocomplete items={keys} value={value} onValueChange={onValueChange} openOnInputClick>
			<AutocompleteInput id={id} placeholder={placeholder} showClear />
			<AutocompletePopup>
				{Result.isInitial(result) && <AutocompleteStatus>Loading attributes…</AutocompleteStatus>}
				{Result.isFailure(result) && (
					<AutocompleteStatus>
						Couldn't load attribute suggestions — you can still type a key
					</AutocompleteStatus>
				)}
				<AutocompleteEmpty>No matching attributes — press Enter to use as typed</AutocompleteEmpty>
				<AutocompleteList>
					<AutocompleteCollection>
						{(key: string) => (
							<AutocompleteItem key={key} value={key}>
								{key}
							</AutocompleteItem>
						)}
					</AutocompleteCollection>
				</AutocompleteList>
			</AutocompletePopup>
		</Autocomplete>
	)
}
