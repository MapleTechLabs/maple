package provider

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"sort"

	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// toWire converts a known Terraform value into its JSON form. Unknown values
// inside collections are dropped; the caller skips unknown top-level values.
func toWire(v tftypes.Value) (any, error) {
	if v.IsNull() || !v.IsKnown() {
		return nil, nil
	}
	t := v.Type()
	switch {
	case t.Is(tftypes.String):
		var s string
		err := v.As(&s)
		return s, err
	case t.Is(tftypes.Bool):
		var b bool
		err := v.As(&b)
		return b, err
	case t.Is(tftypes.Number):
		var f big.Float
		if err := v.As(&f); err != nil {
			return nil, err
		}
		if f.IsInt() {
			return json.Number(f.Text('f', 0)), nil
		}
		return json.Number(f.Text('g', -1)), nil
	case t.Is(tftypes.List{}), t.Is(tftypes.Set{}):
		var items []tftypes.Value
		if err := v.As(&items); err != nil {
			return nil, err
		}
		out := make([]any, 0, len(items))
		for _, item := range items {
			if !item.IsKnown() {
				continue
			}
			converted, err := toWire(item)
			if err != nil {
				return nil, err
			}
			out = append(out, converted)
		}
		return out, nil
	case t.Is(tftypes.Map{}), t.Is(tftypes.Object{}):
		var fields map[string]tftypes.Value
		if err := v.As(&fields); err != nil {
			return nil, err
		}
		out := map[string]any{}
		for key, field := range fields {
			if field.IsNull() || !field.IsKnown() {
				continue
			}
			converted, err := toWire(field)
			if err != nil {
				return nil, err
			}
			out[key] = converted
		}
		return out, nil
	}
	return nil, fmt.Errorf("unsupported Terraform type %s", t)
}

// fromWire builds a Terraform value of type t from decoded JSON. Missing
// object keys become null; unknown keys are ignored.
func fromWire(t tftypes.Type, raw any) (tftypes.Value, error) {
	if raw == nil {
		return tftypes.NewValue(t, nil), nil
	}
	switch {
	case t.Is(tftypes.String):
		switch s := raw.(type) {
		case string:
			return tftypes.NewValue(t, s), nil
		case json.Number:
			return tftypes.NewValue(t, s.String()), nil
		}
	case t.Is(tftypes.Bool):
		if b, ok := raw.(bool); ok {
			return tftypes.NewValue(t, b), nil
		}
	case t.Is(tftypes.Number):
		if n, ok := raw.(json.Number); ok {
			return numberValue(t, n)
		}
	case t.Is(tftypes.List{}), t.Is(tftypes.Set{}):
		items, ok := raw.([]any)
		if !ok {
			break
		}
		var elem tftypes.Type
		if list, isList := t.(tftypes.List); isList {
			elem = list.ElementType
		} else {
			elem = t.(tftypes.Set).ElementType
		}
		values := make([]tftypes.Value, 0, len(items))
		for _, item := range items {
			value, err := fromWire(elem, item)
			if err != nil {
				return tftypes.Value{}, err
			}
			values = append(values, value)
		}
		return tftypes.NewValue(t, values), nil
	case t.Is(tftypes.Map{}):
		fields, ok := raw.(map[string]any)
		if !ok {
			break
		}
		values := map[string]tftypes.Value{}
		for key, field := range fields {
			value, err := fromWire(t.(tftypes.Map).ElementType, field)
			if err != nil {
				return tftypes.Value{}, err
			}
			values[key] = value
		}
		return tftypes.NewValue(t, values), nil
	case t.Is(tftypes.Object{}):
		fields, ok := raw.(map[string]any)
		if !ok {
			break
		}
		values := map[string]tftypes.Value{}
		for key, attrType := range t.(tftypes.Object).AttributeTypes {
			value, err := fromWire(attrType, fields[key])
			if err != nil {
				return tftypes.Value{}, err
			}
			values[key] = value
		}
		return tftypes.NewValue(t, values), nil
	}
	return tftypes.Value{}, fmt.Errorf("cannot read %T as %s", raw, t)
}

// numberValue keeps integers exact and reads fractions as float64, the
// precision Float64 attributes plan with; a wider parse of 0.05 would differ
// from the configured 0.05 and show as drift.
func numberValue(t tftypes.Type, n json.Number) (tftypes.Value, error) {
	if i, ok := new(big.Int).SetString(n.String(), 10); ok {
		return tftypes.NewValue(t, new(big.Float).SetInt(i)), nil
	}
	f, err := n.Float64()
	if err != nil {
		return tftypes.Value{}, err
	}
	return tftypes.NewValue(t, big.NewFloat(f)), nil
}

// isEmptyWire reports whether a wire value carries nothing: null, "", [] or {}.
func isEmptyWire(raw any) bool {
	switch v := raw.(type) {
	case nil:
		return true
	case string:
		return v == ""
	case []any:
		return len(v) == 0
	case map[string]any:
		return len(v) == 0
	}
	return false
}

// jsonCovers reports whether every value the user wrote in want is present
// and equal in got. The API may add defaults (extra keys, server ids), which
// must not show up as drift. Arrays must match element for element.
func jsonCovers(want, got any) bool {
	switch w := want.(type) {
	case nil:
		return true
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return false
		}
		for key, value := range w {
			if !jsonCovers(value, g[key]) {
				return false
			}
		}
		return true
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return false
		}
		for i := range w {
			if !jsonCovers(w[i], g[i]) {
				return false
			}
		}
		return true
	case json.Number:
		g, ok := got.(json.Number)
		if !ok {
			return false
		}
		a, _, errA := big.ParseFloat(w.String(), 10, 512, big.ToNearestEven)
		b, _, errB := big.ParseFloat(g.String(), 10, 512, big.ToNearestEven)
		return errA == nil && errB == nil && a.Cmp(b) == 0
	}
	return reflect.DeepEqual(want, got)
}

func parseJSON(s string) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader([]byte(s)))
	decoder.UseNumber()
	var out any
	if err := decoder.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// canonicalJSON renders a value with sorted keys, matching what jsonencode
// produces for the same document.
func canonicalJSON(v any) (string, error) {
	var buf bytes.Buffer
	if err := writeCanonical(&buf, v); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch value := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			encoded, _ := json.Marshal(key)
			buf.Write(encoded)
			buf.WriteByte(':')
			if err := writeCanonical(buf, value[key]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, item := range value {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		encoder := json.NewEncoder(buf)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(value); err != nil {
			return err
		}
		// Encoder appends a newline.
		buf.Truncate(buf.Len() - 1)
	}
	return nil
}

// equivalent compares values the way the API stores them: numbers at float64
// precision, everything else exactly.
func equivalent(a, b tftypes.Value) bool {
	if !a.Type().Equal(b.Type()) || a.IsNull() != b.IsNull() || !a.IsKnown() || !b.IsKnown() {
		return false
	}
	if a.IsNull() {
		return true
	}
	t := a.Type()
	switch {
	case t.Is(tftypes.Number):
		var x, y big.Float
		if a.As(&x) != nil || b.As(&y) != nil {
			return false
		}
		fx, _ := x.Float64()
		fy, _ := y.Float64()
		return fx == fy
	case t.Is(tftypes.List{}), t.Is(tftypes.Set{}):
		var xs, ys []tftypes.Value
		if a.As(&xs) != nil || b.As(&ys) != nil || len(xs) != len(ys) {
			return false
		}
		if t.Is(tftypes.Set{}) {
			return a.Equal(b)
		}
		for i := range xs {
			if !equivalent(xs[i], ys[i]) {
				return false
			}
		}
		return true
	case t.Is(tftypes.Map{}), t.Is(tftypes.Object{}):
		var xs, ys map[string]tftypes.Value
		if a.As(&xs) != nil || b.As(&ys) != nil || len(xs) != len(ys) {
			return false
		}
		for key, x := range xs {
			y, ok := ys[key]
			if !ok || !equivalent(x, y) {
				return false
			}
		}
		return true
	}
	return a.Equal(b)
}
