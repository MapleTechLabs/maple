package provider

import (
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

func idAttribute(prefix string) schema.StringAttribute {
	return schema.StringAttribute{
		Computed:      true,
		Description:   "The `" + prefix + "_…` public ID.",
		PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
	}
}

func readOnlyString(description string) schema.StringAttribute {
	return schema.StringAttribute{
		Computed:      true,
		Description:   description,
		PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
	}
}

func oneOf(values ...string) []validator.String {
	return []validator.String{stringvalidator.OneOf(values...)}
}

func stringList(description string, optionalComputed bool) schema.ListAttribute {
	return schema.ListAttribute{
		ElementType: types.StringType,
		Optional:    true,
		Computed:    optionalComputed,
		Description: description,
	}
}

func jsonAttribute(description string, required, computed bool) schema.StringAttribute {
	return schema.StringAttribute{
		Required:    required,
		Optional:    !required,
		Computed:    computed,
		Description: description + " Write it with `jsonencode(...)`.",
		Validators:  []validator.String{jsonValidator{}},
	}
}
