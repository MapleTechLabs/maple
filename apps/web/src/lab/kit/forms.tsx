import { MagnifierIcon, XmarkIcon } from "@maple/ui/components/icons"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { Input } from "@maple/ui/components/ui/input"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { Label } from "@maple/ui/components/ui/label"
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { OTPField, OTPFieldInput, OTPFieldSeparator } from "@maple/ui/components/ui/otp-field"
import { Radio, RadioGroup } from "@maple/ui/components/ui/radio-group"
import { Switch } from "@maple/ui/components/ui/switch"
import { Textarea } from "@maple/ui/components/ui/textarea"

import { KitPage, KitRow, KitSection } from "./kit-layout"
import { KitAutocomplete, KitCombobox, KitComboboxChips, KitSelect } from "./pickers"

const INPUT_SIZES = ["sm", "default", "lg"] as const

export function KitFormsLab() {
	return (
		<KitPage
			title="Kit: forms"
			description="Inputs, fields and choice controls from @maple/ui, every picker closed."
		>
			<KitSection title="Input">
				<KitRow label="sizes">
					{INPUT_SIZES.map((size) => (
						<Input
							key={size}
							size={size}
							className="w-48"
							aria-label={`Input ${size}`}
							placeholder={`Size ${size}`}
						/>
					))}
				</KitRow>
				<KitRow label="states">
					<Input className="w-48" aria-label="Service name" defaultValue="checkout-svc" />
					<Input
						className="w-48"
						aria-label="Invalid input"
						aria-invalid
						defaultValue="not a url"
					/>
					<Input className="w-48" aria-label="Disabled input" disabled defaultValue="read only" />
				</KitRow>
			</KitSection>
			<KitSection title="Textarea">
				<KitRow>
					<Textarea className="w-72" aria-label="Notes" placeholder="Describe the incident" />
					<Textarea
						className="w-72"
						aria-label="Invalid notes"
						aria-invalid
						defaultValue="Too short"
					/>
					<Textarea className="w-72" aria-label="Disabled notes" disabled defaultValue="Locked" />
				</KitRow>
			</KitSection>
			<KitSection title="Input group">
				<KitRow>
					<InputGroup className="w-72">
						<InputGroupAddon>
							<MagnifierIcon />
						</InputGroupAddon>
						<InputGroupInput aria-label="Search spans" placeholder="Search spans" />
						<InputGroupAddon align="inline-end">
							<InputGroupButton aria-label="Clear search" size="icon-xs">
								<XmarkIcon />
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>
					<InputGroup className="w-72">
						<InputGroupAddon>
							<InputGroupText>https://</InputGroupText>
						</InputGroupAddon>
						<InputGroupInput aria-label="Endpoint" defaultValue="ingest.maple.dev" />
						<InputGroupAddon align="inline-end">
							<InputGroupText>/v1/traces</InputGroupText>
						</InputGroupAddon>
					</InputGroup>
				</KitRow>
			</KitSection>
			<KitSection title="Field">
				<div className="grid max-w-3xl grid-cols-2 gap-6">
					<Field>
						<FieldLabel>Dashboard name</FieldLabel>
						<Input defaultValue="Checkout latency" />
						<FieldDescription>Shown in the sidebar and in alert notifications.</FieldDescription>
					</Field>
					<Field invalid>
						<FieldLabel>Webhook URL</FieldLabel>
						<Input defaultValue="hooks.example" />
						<FieldError match>Enter a full URL starting with https://</FieldError>
					</Field>
				</div>
			</KitSection>
			<KitSection title="Checkbox, radio group, switch">
				<KitRow label="checkbox">
					<Label className="flex items-center gap-2">
						<Checkbox /> Unchecked
					</Label>
					<Label className="flex items-center gap-2">
						<Checkbox defaultChecked /> Checked
					</Label>
					<Label className="flex items-center gap-2">
						<Checkbox indeterminate /> Indeterminate
					</Label>
					<Label className="flex items-center gap-2">
						<Checkbox disabled /> Disabled
					</Label>
				</KitRow>
				<KitRow label="radio group">
					<RadioGroup defaultValue="p95" aria-label="Percentile" className="flex flex-row gap-4">
						{["p50", "p95", "p99"].map((value) => (
							<Label key={value} className="flex items-center gap-2">
								<Radio value={value} /> {value}
							</Label>
						))}
						<Label className="flex items-center gap-2">
							<Radio value="max" disabled /> max
						</Label>
					</RadioGroup>
				</KitRow>
				<KitRow label="switch">
					<Label className="flex items-center gap-2">
						<Switch /> Off
					</Label>
					<Label className="flex items-center gap-2">
						<Switch defaultChecked /> On
					</Label>
					<Label className="flex items-center gap-2">
						<Switch disabled /> Disabled
					</Label>
				</KitRow>
			</KitSection>
			<KitSection title="Native select">
				<KitRow>
					<NativeSelect aria-label="Region" defaultValue="us" className="w-48">
						<NativeSelectOptGroup label="Regions">
							<NativeSelectOption value="us">United States</NativeSelectOption>
							<NativeSelectOption value="eu">Europe</NativeSelectOption>
						</NativeSelectOptGroup>
					</NativeSelect>
					<NativeSelect aria-label="Small region" size="sm" defaultValue="eu" className="w-48">
						<NativeSelectOption value="us">United States</NativeSelectOption>
						<NativeSelectOption value="eu">Europe</NativeSelectOption>
					</NativeSelect>
					<NativeSelect aria-label="Disabled region" disabled className="w-48">
						<NativeSelectOption value="us">United States</NativeSelectOption>
					</NativeSelect>
				</KitRow>
			</KitSection>
			<KitSection title="Select, combobox, autocomplete (closed)">
				<KitRow>
					<KitSelect />
					<KitCombobox />
					<KitAutocomplete />
				</KitRow>
				<KitRow>
					<KitComboboxChips />
				</KitRow>
			</KitSection>
			<KitSection title="OTP field and label">
				<KitRow>
					<OTPField length={6} defaultValue="482" aria-label="Verification code">
						<OTPFieldInput />
						<OTPFieldInput />
						<OTPFieldInput />
						<OTPFieldSeparator />
						<OTPFieldInput />
						<OTPFieldInput />
						<OTPFieldInput />
					</OTPField>
					<Label>Standalone label</Label>
				</KitRow>
			</KitSection>
		</KitPage>
	)
}
