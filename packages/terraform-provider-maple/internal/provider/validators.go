package provider

import (
	"context"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
)

type jsonValidator struct{}

func (jsonValidator) Description(context.Context) string { return "value must be valid JSON" }

func (v jsonValidator) MarkdownDescription(ctx context.Context) string { return v.Description(ctx) }

func (jsonValidator) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	if _, err := parseJSON(req.ConfigValue.ValueString()); err != nil {
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid JSON", err.Error())
	}
}

// lowercaseValidator matches values the API lowercases, which would otherwise
// fail Terraform's consistency check after apply.
type lowercaseValidator struct{}

func (lowercaseValidator) Description(context.Context) string {
	return "value must be lowercase without surrounding spaces"
}

func (v lowercaseValidator) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}

func (lowercaseValidator) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	value := req.ConfigValue.ValueString()
	if value != strings.ToLower(strings.TrimSpace(value)) {
		resp.Diagnostics.AddAttributeError(req.Path, "Tag must be lowercase", "Maple stores tags lowercased and trimmed; write \""+strings.ToLower(strings.TrimSpace(value))+"\".")
	}
}
