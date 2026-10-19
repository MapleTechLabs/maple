import { MagnifierIcon } from "@maple/ui/components/icons"
import {
	Autocomplete,
	AutocompleteEmpty,
	AutocompleteInput,
	AutocompleteItem,
	AutocompleteList,
	AutocompletePopup,
} from "@maple/ui/components/ui/autocomplete"
import {
	Combobox,
	ComboboxChip,
	ComboboxChips,
	ComboboxChipsInput,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	useComboboxAnchor,
} from "@maple/ui/components/ui/combobox"
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectGroupLabel,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"

// Select, combobox and autocomplete fixtures shared by the forms page (closed) and the
// overlays page (open), so both parity targets render the same items.
export const SERVICES = [
	"api-gateway",
	"checkout-svc",
	"payment-svc",
	"inventory-svc",
	"notification-svc",
] as const

const ENVIRONMENTS = [
	{ value: "production", label: "Production" },
	{ value: "staging", label: "Staging" },
	{ value: "development", label: "Development" },
] as const

export function KitSelect({ open = false }: { open?: boolean }) {
	return (
		<Select items={ENVIRONMENTS} defaultValue="staging" defaultOpen={open}>
			<SelectTrigger className="w-56" aria-label="Environment">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					<SelectGroupLabel>Deployed</SelectGroupLabel>
					<SelectItem value="production">Production</SelectItem>
					<SelectItem value="staging">Staging</SelectItem>
				</SelectGroup>
				<SelectSeparator />
				<SelectItem value="development">Development</SelectItem>
			</SelectContent>
		</Select>
	)
}

export function KitCombobox({ open = false }: { open?: boolean }) {
	return (
		<Combobox items={SERVICES} defaultValue="payment-svc" defaultOpen={open}>
			<div className="w-64">
				<ComboboxInput
					aria-label="Service"
					placeholder="Pick a service"
					startAddon={<MagnifierIcon />}
				/>
			</div>
			<ComboboxContent>
				<ComboboxEmpty>No services found.</ComboboxEmpty>
				<ComboboxList>
					{(item: string) => (
						<ComboboxItem key={item} value={item}>
							{item}
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	)
}

export function KitComboboxChips({ open = false }: { open?: boolean }) {
	const anchor = useComboboxAnchor()
	const selected = ["checkout-svc", "payment-svc"]
	return (
		<Combobox items={SERVICES} multiple defaultValue={selected} defaultOpen={open}>
			<ComboboxChips ref={anchor} className="w-96">
				{selected.map((item) => (
					<ComboboxChip key={item}>{item}</ComboboxChip>
				))}
				<ComboboxChipsInput aria-label="Services" placeholder="Add a service" />
			</ComboboxChips>
			<ComboboxContent anchor={anchor}>
				<ComboboxEmpty>No services found.</ComboboxEmpty>
				<ComboboxList>
					{(item: string) => (
						<ComboboxItem key={item} value={item}>
							{item}
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	)
}

export function KitAutocomplete({ open = false }: { open?: boolean }) {
	return (
		<Autocomplete items={SERVICES} defaultOpen={open}>
			<div className="w-64">
				<AutocompleteInput
					aria-label="Search services"
					placeholder="Search services"
					startAddon={<MagnifierIcon />}
				/>
			</div>
			<AutocompletePopup>
				<AutocompleteEmpty>No matches.</AutocompleteEmpty>
				<AutocompleteList>
					{(item: string) => (
						<AutocompleteItem key={item} value={item}>
							{item}
						</AutocompleteItem>
					)}
				</AutocompleteList>
			</AutocompletePopup>
		</Autocomplete>
	)
}
