package provider

import (
	"context"
	"fmt"
	"net/url"

	"github.com/MapleTechLabs/terraform-provider-maple/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// field describes how one top-level attribute maps to the wire. Attributes
// absent from resourceDef.fields are plain inputs sent as-is and read back.
type field struct {
	// json marks a string attribute holding a JSON document (use jsonencode).
	json bool
	// jsonList marks a JSON attribute whose document is a list: the API takes
	// [] to clear it, not null.
	jsonList bool
	// writeOnly values are never returned by the API (secrets, some URLs), so
	// state keeps the configured value and drift cannot be detected.
	writeOnly bool
	// createOnly values are not accepted by PATCH; the schema must force replacement.
	createOnly bool
	// readOnly values are computed by the API and never sent.
	readOnly bool
}

// resourceDef is one Maple object managed through its v2 collection:
// POST {collection}, GET/PATCH/DELETE {collection}/{id}.
type resourceDef struct {
	typeName   string
	collection string
	schema     schema.Schema
	fields     map[string]field
	// prepareBody adjusts a create (create=true) or update request body.
	prepareBody func(body map[string]any, create bool) error
	// update replaces the PATCH; it returns the object to read state from.
	update func(ctx context.Context, c *client.Client, id string, plan, prior map[string]tftypes.Value) (client.Object, error)
	// gone reports an object that still exists but should count as deleted.
	gone func(obj client.Object) bool
}

type genericResource struct {
	def    resourceDef
	client *client.Client
}

var (
	_ resource.Resource                = (*genericResource)(nil)
	_ resource.ResourceWithConfigure   = (*genericResource)(nil)
	_ resource.ResourceWithImportState = (*genericResource)(nil)
)

func newResource(def resourceDef) func() resource.Resource {
	return func() resource.Resource { return &genericResource{def: def} }
}

func (r *genericResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_" + r.def.typeName
}

func (r *genericResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = r.def.schema
}

func (r *genericResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", req.ProviderData))
		return
	}
	r.client = c
}

func (r *genericResource) itemPath(id string) string {
	return r.def.collection + "/" + url.PathEscape(id)
}

func (r *genericResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	plan, err := objectValues(req.Plan.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Reading plan", err.Error())
		return
	}
	body, err := r.body(plan, nil, true)
	if err != nil {
		resp.Diagnostics.AddError("Building request", err.Error())
		return
	}
	obj, err := r.client.Post(ctx, r.def.collection, body)
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Creating %s", r.def.typeName), err.Error())
		return
	}
	resp.Diagnostics.Append(r.setState(ctx, &resp.State, obj, plan, plan)...)
}

func (r *genericResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	prior, err := objectValues(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Reading state", err.Error())
		return
	}
	id, err := stringValue(prior["id"])
	if err != nil || id == "" {
		resp.Diagnostics.AddError("Reading state", "state has no id")
		return
	}
	obj, err := r.client.Get(ctx, r.itemPath(id))
	if client.IsNotFound(err) || (err == nil && r.def.gone != nil && r.def.gone(obj)) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Reading %s %s", r.def.typeName, id), err.Error())
		return
	}
	resp.Diagnostics.Append(r.setState(ctx, &resp.State, obj, prior, prior)...)
}

func (r *genericResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	plan, err := objectValues(req.Plan.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Reading plan", err.Error())
		return
	}
	prior, err := objectValues(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Reading state", err.Error())
		return
	}
	id, err := stringValue(prior["id"])
	if err != nil {
		resp.Diagnostics.AddError("Reading state", err.Error())
		return
	}
	var obj client.Object
	if r.def.update != nil {
		obj, err = r.def.update(ctx, r.client, id, plan, prior)
	} else {
		var body map[string]any
		body, err = r.body(plan, prior, false)
		if err == nil {
			obj, err = r.client.Patch(ctx, r.itemPath(id), body)
		}
	}
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Updating %s %s", r.def.typeName, id), err.Error())
		return
	}
	resp.Diagnostics.Append(r.setState(ctx, &resp.State, obj, plan, prior)...)
}

func (r *genericResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	prior, err := objectValues(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Reading state", err.Error())
		return
	}
	id, err := stringValue(prior["id"])
	if err != nil {
		resp.Diagnostics.AddError("Reading state", err.Error())
		return
	}
	if err := r.client.Delete(ctx, r.itemPath(id)); err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(fmt.Sprintf("Deleting %s %s", r.def.typeName, id), err.Error())
	}
}

func (r *genericResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

// body builds the request from the plan. On update, an optional attribute the
// user removed is sent as null (or []) so the API clears it.
func (r *genericResource) body(plan, prior map[string]tftypes.Value, create bool) (map[string]any, error) {
	body := map[string]any{}
	for name, attr := range r.def.schema.Attributes {
		f := r.def.fields[name]
		if name == "id" || f.readOnly || !attr.IsOptional() && !attr.IsRequired() || !create && f.createOnly {
			continue
		}
		value, ok := plan[name]
		if !ok || !value.IsKnown() {
			continue
		}
		if value.IsNull() {
			if !create && !f.writeOnly && !attr.IsComputed() && prior[name].IsKnown() && !prior[name].IsNull() {
				if f.jsonList || value.Type().Is(tftypes.List{}) || value.Type().Is(tftypes.Set{}) {
					body[name] = []any{}
				} else {
					body[name] = nil
				}
			}
			continue
		}
		if f.json {
			s, err := stringValue(value)
			if err != nil {
				return nil, err
			}
			parsed, err := parseJSON(s)
			if err != nil {
				return nil, fmt.Errorf("%s is not valid JSON: %w", name, err)
			}
			body[name] = parsed
			continue
		}
		wire, err := toWire(value)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		body[name] = wire
	}
	if r.def.prepareBody != nil {
		if err := r.def.prepareBody(body, create); err != nil {
			return nil, err
		}
	}
	return body, nil
}

// setState writes the API object into state. base is what the user asked for
// (the plan, or prior state on refresh); fallback fills values the API does
// not echo, such as a secret returned only once.
func (r *genericResource) setState(ctx context.Context, state *tfsdk.State, obj client.Object, base, fallback map[string]tftypes.Value) diag.Diagnostics {
	var diags diag.Diagnostics
	objectType, ok := r.def.schema.Type().TerraformType(ctx).(tftypes.Object)
	if !ok {
		diags.AddError("Internal error", "resource schema is not an object")
		return diags
	}
	values := map[string]tftypes.Value{}
	for name, attrType := range objectType.AttributeTypes {
		value, err := r.stateValue(name, attrType, obj, base, fallback)
		if err != nil {
			diags.AddError(fmt.Sprintf("Reading %s.%s from the API", r.def.typeName, name), err.Error())
			return diags
		}
		values[name] = value
	}
	state.Raw = tftypes.NewValue(objectType, values)
	return diags
}

func (r *genericResource) stateValue(name string, t tftypes.Type, obj client.Object, base, fallback map[string]tftypes.Value) (tftypes.Value, error) {
	f := r.def.fields[name]
	attr := r.def.schema.Attributes[name]
	known := func(v tftypes.Value, ok bool) bool { return ok && v.IsKnown() }
	baseValue, hasBase := base[name]
	fallbackValue, hasFallback := fallback[name]
	keep := func() tftypes.Value {
		if known(baseValue, hasBase) {
			return baseValue
		}
		if known(fallbackValue, hasFallback) {
			return fallbackValue
		}
		return tftypes.NewValue(t, nil)
	}

	raw, present := obj[name]
	if f.writeOnly || !present {
		return keep(), nil
	}
	userUnset := known(baseValue, hasBase) && baseValue.IsNull() && !attr.IsComputed()
	if userUnset && isEmptyWire(raw) {
		return tftypes.NewValue(t, nil), nil
	}
	if f.json {
		if raw == nil {
			return tftypes.NewValue(t, nil), nil
		}
		if known(baseValue, hasBase) && !baseValue.IsNull() {
			s, err := stringValue(baseValue)
			if err != nil {
				return tftypes.Value{}, err
			}
			// Keep the user's formatting while the API still holds what they wrote.
			if want, err := parseJSON(s); err == nil && jsonCovers(want, raw) {
				return baseValue, nil
			}
		}
		s, err := canonicalJSON(raw)
		if err != nil {
			return tftypes.Value{}, err
		}
		return tftypes.NewValue(t, s), nil
	}
	value, err := fromWire(t, raw)
	if err == nil && known(baseValue, hasBase) && equivalent(baseValue, value) {
		// Same value; keep the planned one exactly (HCL numbers carry more precision than float64).
		return baseValue, nil
	}
	return value, err
}

func objectValues(raw tftypes.Value) (map[string]tftypes.Value, error) {
	values := map[string]tftypes.Value{}
	if raw.IsNull() {
		return values, nil
	}
	err := raw.As(&values)
	return values, err
}

func stringValue(v tftypes.Value) (string, error) {
	if v.IsNull() || !v.IsKnown() {
		return "", nil
	}
	var s string
	err := v.As(&s)
	return s, err
}
