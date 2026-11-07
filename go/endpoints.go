package kpax

import (
	"context"
	"encoding/json"
	"errors"
	"iter"
	"net/url"
	"strconv"
	"strings"
)

// Scope limits a listing to a hierarchy container. ParentType is "account" or
// "dynamic_group". WithChildren applies to accounts only.
type Scope struct {
	ParentType   string
	ParentID     int64
	WithChildren *bool
}

func (s *Scope) query(q map[string]any) {
	if s == nil || s.ParentType == "" {
		return
	}
	q["parent_type"] = s.ParentType
	q["parent_id"] = s.ParentID
	if s.ParentType == "account" && s.WithChildren != nil {
		q["with_children"] = *s.WithChildren
	}
}

// Bool returns a pointer to b, for optional fields.
func Bool(b bool) *bool { return &b }

// ----------------------------------------------------------- server/hierarchy

// ServerStatus calls GET /server/status.
func (c *Client) ServerStatus(ctx context.Context) (*ServerStatus, error) {
	var s ServerStatus
	if err := c.Do(ctx, "GET", "/server/status", RequestOptions{}, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Hierarchy returns accounts, agents, devices and dynamic groups under a
// container; empty objectType means the API client's own level.
func (c *Client) Hierarchy(ctx context.Context, objectType string, objectID int64) (map[string]any, error) {
	q := map[string]any{}
	if objectType != "" {
		q["object_type"], q["object_id"] = objectType, objectID
	}
	var out map[string]any
	err := c.Do(ctx, "GET", "/hierarchy-elements", RequestOptions{Query: q}, &out)
	return out, err
}

// ------------------------------------------------------------------ accounts

// AccountListOptions filter ListAccounts.
type AccountListOptions struct {
	ParentID     *int64
	WithChildren *bool
	Page         int
}

// ListAccounts returns one page of accounts.
func (c *Client) ListAccounts(ctx context.Context, opts AccountListOptions) (*Page[Account], error) {
	q := map[string]any{}
	if opts.Page > 0 {
		q["page"] = opts.Page
	}
	if opts.ParentID != nil {
		q["parent_type"], q["parent_id"] = "account", *opts.ParentID
		if opts.WithChildren != nil {
			q["with_children"] = *opts.WithChildren
		}
	}
	var p Page[Account]
	if err := c.Do(ctx, "GET", "/accounts", RequestOptions{Query: q}, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// Accounts iterates every account across pages.
func (c *Client) Accounts(ctx context.Context, opts AccountListOptions) iter.Seq2[Account, error] {
	return Paginate(func(page int) (*Page[Account], error) {
		o := opts
		o.Page = page
		return c.ListAccounts(ctx, o)
	})
}

// GetAccount returns one account.
func (c *Client) GetAccount(ctx context.Context, id int64) (*Account, error) {
	var a Account
	if err := c.Do(ctx, "GET", "/accounts/{id}", RequestOptions{PathParams: map[string]any{"id": id}}, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// ------------------------------------------------------------------- devices

// DeviceListOptions filter ListDevices. Schema defaults to "core"; PerPage
// (≤1000) is only sent with the core schema (B12).
type DeviceListOptions struct {
	Scope   *Scope
	Schema  string
	Page    int
	PerPage int
	Sort    string
}

// ListDevices returns one page of devices.
func (c *Client) ListDevices(ctx context.Context, opts DeviceListOptions) (*Page[Device], error) {
	schema := opts.Schema
	if schema == "" {
		schema = "core"
	}
	q := map[string]any{"schema": schema}
	opts.Scope.query(q)
	if opts.Page > 0 {
		q["page"] = opts.Page
	}
	if opts.PerPage > 0 && schema == "core" {
		q["per_page"] = opts.PerPage
	}
	if opts.Sort != "" {
		q["sort"] = opts.Sort
	}
	var p Page[Device]
	if err := c.Do(ctx, "GET", "/devices", RequestOptions{Query: q}, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// Devices iterates every device; 1000 per page on the core schema (B12).
func (c *Client) Devices(ctx context.Context, opts DeviceListOptions) iter.Seq2[Device, error] {
	if opts.PerPage == 0 && (opts.Schema == "" || opts.Schema == "core") {
		opts.PerPage = 1000
	}
	return Paginate(func(page int) (*Page[Device], error) {
		o := opts
		o.Page = page
		return c.ListDevices(ctx, o)
	})
}

// GetDevice returns a full device; meters, supplies, … are in Raw.
func (c *Client) GetDevice(ctx context.Context, id int64) (*Device, error) {
	var d Device
	if err := c.Do(ctx, "GET", "/devices/{id}", RequestOptions{PathParams: map[string]any{"id": id}}, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// SearchDevicesBySerial is a partial serial search (≥5 characters), all pages.
func (c *Client) SearchDevicesBySerial(ctx context.Context, serial string, scope *Scope) ([]Device, error) {
	s := strings.TrimSpace(serial)
	if len(s) < 5 {
		return nil, ErrSerialTooShort
	}
	return Collect(Paginate(func(page int) (*Page[Device], error) {
		q := map[string]any{"serial_number": s, "page": page}
		scope.query(q)
		var p Page[Device]
		if err := c.Do(ctx, "GET", "/devices/search-by-serial-number", RequestOptions{Query: q}, &p); err != nil {
			return nil, err
		}
		return &p, nil
	}))
}

// FindDeviceBySerial returns the device whose effective or original serial
// equals serial (case-insensitive), nil if none, and an *APIError with status
// 409 if several match (B13).
func (c *Client) FindDeviceBySerial(ctx context.Context, serial string, scope *Scope) (*Device, error) {
	want := strings.ToUpper(strings.TrimSpace(serial))
	all, err := c.SearchDevicesBySerial(ctx, want, scope)
	if err != nil {
		return nil, err
	}
	var hits []Device
	for _, d := range all {
		if strings.ToUpper(strings.TrimSpace(d.SerialNumber)) == want || strings.ToUpper(strings.TrimSpace(d.SerialNumberOrigin)) == want {
			hits = append(hits, d)
		}
	}
	switch len(hits) {
	case 0:
		return nil, nil
	case 1:
		return &hits[0], nil
	default:
		ids := make([]int64, len(hits))
		for i, h := range hits {
			ids[i] = int64(h.ID)
		}
		return nil, &APIError{
			Status: 409, Method: "GET", Path: "/devices/search-by-serial-number",
			Body: map[string]any{"matches": ids},
			Msg:  "serial " + want + " matches " + strconv.Itoa(len(hits)) + " KPAX devices",
		}
	}
}

// AttributeRef names a device attribute, e.g. {"kpax.core.print.devices", "engine_count"}.
type AttributeRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// SearchFilter filters POST /devices/search; only last_check and serial_number are filterable.
type SearchFilter struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Operator  string `json:"operator"`
	Value     string `json:"value"`
}

// DeviceSearchOptions are the inputs of SearchDevices (B14).
type DeviceSearchOptions struct {
	Scope                   *Scope
	Attributes              []AttributeRef
	Filters                 []SearchFilter
	AttributesWithLastCheck *bool
	ProfileIDs              []int64
	Sort                    string
	Page                    int
	PerPage                 int
}

// SearchDevices calls POST /devices/search (form-encoded): bulk read of chosen
// attributes across a fleet.
func (c *Client) SearchDevices(ctx context.Context, opts DeviceSearchOptions) (*Page[map[string]any], error) {
	form := url.Values{}
	if s := opts.Scope; s != nil && s.ParentType != "" {
		form.Set("parent_type", s.ParentType)
		form.Set("parent_id", strconv.FormatInt(s.ParentID, 10))
		if s.WithChildren != nil {
			form.Set("with_children", boolDigit(*s.WithChildren))
		}
	}
	if len(opts.Attributes) > 0 {
		b, _ := json.Marshal(opts.Attributes)
		form.Set("attributes", string(b))
	}
	if len(opts.Filters) > 0 {
		b, _ := json.Marshal(opts.Filters)
		form.Set("filters", string(b))
	}
	if opts.AttributesWithLastCheck != nil {
		form.Set("attributes_with_last_check", boolDigit(*opts.AttributesWithLastCheck))
	}
	if len(opts.ProfileIDs) > 0 {
		ids := make([]string, len(opts.ProfileIDs))
		for i, id := range opts.ProfileIDs {
			ids[i] = strconv.FormatInt(id, 10)
		}
		form.Set("profile_id", strings.Join(ids, ","))
	}
	if opts.Sort != "" {
		form.Set("sort", opts.Sort)
	}
	if opts.Page > 0 {
		form.Set("page", strconv.Itoa(opts.Page))
	}
	if opts.PerPage > 0 {
		form.Set("per_page", strconv.Itoa(opts.PerPage))
	}
	var p Page[map[string]any]
	if err := c.Do(ctx, "POST", "/devices/search", RequestOptions{Form: form}, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// DeviceSearch iterates every page of SearchDevices.
func (c *Client) DeviceSearch(ctx context.Context, opts DeviceSearchOptions) iter.Seq2[map[string]any, error] {
	return Paginate(func(page int) (*Page[map[string]any], error) {
		o := opts
		o.Page = page
		return c.SearchDevices(ctx, o)
	})
}

// VolumeOptions are the inputs of GetDeviceVolumes. Dates are YYYY-MM-DD (UTC);
// Interval defaults to "daily".
type VolumeOptions struct {
	StartDate, EndDate string
	Interval           string
	VolumeName         string
}

// GetDeviceVolumes returns {volumeName: {date: count}} (B15).
func (c *Client) GetDeviceVolumes(ctx context.Context, id int64, opts VolumeOptions) (Volumes, error) {
	interval := opts.Interval
	if interval == "" {
		interval = "daily"
	}
	q := map[string]any{"interval": interval, "start_date": opts.StartDate, "end_date": opts.EndDate}
	if opts.VolumeName != "" {
		q["volume_name"] = opts.VolumeName
	}
	var v Volumes
	err := c.Do(ctx, "GET", "/devices/{id}/volumes", RequestOptions{PathParams: map[string]any{"id": id}, Query: q}, &v)
	return v, err
}

// DateRange optionally bounds history calls; Sort is "asc" or "desc".
type DateRange struct {
	StartDate, EndDate, Sort string
}

func (r DateRange) query(q map[string]any) map[string]any {
	if r.StartDate != "" {
		q["start_date"] = r.StartDate
	}
	if r.EndDate != "" {
		q["end_date"] = r.EndDate
	}
	if r.Sort != "" {
		q["sort"] = r.Sort
	}
	return q
}

// GetDeviceHistory returns daily snapshots of a device.
func (c *Client) GetDeviceHistory(ctx context.Context, id int64, r DateRange) ([]map[string]any, error) {
	var out []map[string]any
	err := c.Do(ctx, "GET", "/devices/{id}/history", RequestOptions{PathParams: map[string]any{"id": id}, Query: r.query(map[string]any{})}, &out)
	return out, err
}

// GetDeviceAttributeHistory returns one attribute's values over time.
func (c *Client) GetDeviceAttributeHistory(ctx context.Context, id int64, attr AttributeRef, r DateRange) ([]map[string]any, error) {
	q := r.query(map[string]any{"namespace": attr.Namespace, "name": attr.Name})
	var out []map[string]any
	err := c.Do(ctx, "GET", "/devices/{id}/attributes/history", RequestOptions{PathParams: map[string]any{"id": id}, Query: q}, &out)
	return out, err
}

// GetSupplyCycles returns toner cycles for black, cyan, magenta or yellow.
// nbCycles <= 0 means the server default.
func (c *Client) GetSupplyCycles(ctx context.Context, id int64, cartridge string, nbCycles int) ([]map[string]any, error) {
	q := map[string]any{"cartridge": cartridge}
	if nbCycles > 0 {
		q["nb_cycles"] = nbCycles
	}
	var out []map[string]any
	err := c.Do(ctx, "GET", "/devices/{id}/supply-cycles", RequestOptions{PathParams: map[string]any{"id": id}, Query: q}, &out)
	return out, err
}

// GetTechnicalAlertHistory returns a device's alert events, all pages.
func (c *Client) GetTechnicalAlertHistory(ctx context.Context, id int64, r DateRange) ([]AlertHistoryEvent, error) {
	return Collect(Paginate(func(page int) (*Page[AlertHistoryEvent], error) {
		var p Page[AlertHistoryEvent]
		err := c.Do(ctx, "GET", "/devices/{id}/technical-status-events/history",
			RequestOptions{PathParams: map[string]any{"id": id}, Query: r.query(map[string]any{"page": page})}, &p)
		if err != nil {
			return nil, err
		}
		return &p, nil
	}))
}

// ListDeviceAttributes returns the attribute catalogue (filter/locale optional).
func (c *Client) ListDeviceAttributes(ctx context.Context, filter, locale string) (any, error) {
	q := map[string]any{}
	if filter != "" {
		q["filter"] = filter
	}
	if locale != "" {
		q["locale"] = locale
	}
	var out any
	err := c.Do(ctx, "GET", "/devices/attributes", RequestOptions{Query: q}, &out)
	return out, err
}

// ListProfiles returns device profiles.
func (c *Client) ListProfiles(ctx context.Context) (any, error) {
	var out any
	err := c.Do(ctx, "GET", "/profiles", RequestOptions{}, &out)
	return out, err
}

// ----------------------------------------------------------- connection test

// TestConnection fetches a token and calls GET /server/status. It never
// returns an error; the result says what failed (B17).
func (c *Client) TestConnection(ctx context.Context) ConnectionTestResult {
	start := c.now()
	s, err := c.ServerStatus(ctx)
	ms := c.now().Sub(start).Milliseconds()
	if err == nil {
		return ConnectionTestResult{OK: true, LatencyMs: ms, Server: s}
	}
	var authErr *AuthError
	var apiErr *APIError
	switch {
	case errors.As(err, &authErr):
		return ConnectionTestResult{Stage: "auth", Status: authErr.Status, Message: err.Error(), LatencyMs: ms}
	case errors.As(err, &apiErr):
		return ConnectionTestResult{Stage: "api", Status: apiErr.Status, Message: err.Error(), LatencyMs: ms}
	default:
		return ConnectionTestResult{Stage: "api", Message: err.Error(), LatencyMs: ms}
	}
}

// TestCredentials is TestConnection for a config that may be invalid
// (reported as Stage "config").
func TestCredentials(ctx context.Context, cfg Config) ConnectionTestResult {
	c, err := New(cfg)
	if err != nil {
		return ConnectionTestResult{Stage: "config", Message: err.Error()}
	}
	return c.TestConnection(ctx)
}

// ---------------------------------------------------------------- pagination

// Paginate walks KPAX pagination (B11): it stops on the last page, an empty
// page or missing meta. Iteration stops at the first error, which is yielded.
func Paginate[T any](fetch func(page int) (*Page[T], error)) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		page := 1
		for {
			p, err := fetch(page)
			if err != nil {
				var zero T
				yield(zero, err)
				return
			}
			for _, item := range p.Data {
				if !yield(item, nil) {
					return
				}
			}
			if len(p.Data) == 0 || p.Meta == nil {
				return
			}
			current := int(p.Meta.CurrentPage)
			if current == 0 {
				current = page
			}
			last := int(p.Meta.LastPage)
			if last == 0 {
				last = current
			}
			if current >= last {
				return
			}
			page = current + 1
		}
	}
}

// Collect drains an iterator into a slice, stopping at the first error.
func Collect[T any](seq iter.Seq2[T, error]) ([]T, error) {
	var out []T
	for v, err := range seq {
		if err != nil {
			return out, err
		}
		out = append(out, v)
	}
	return out, nil
}

func boolDigit(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
