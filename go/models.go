package kpax

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// FlexInt decodes KPAX ids sent as JSON numbers or numeric strings (B18).
// A missing, null or non-numeric value decodes to 0.
type FlexInt int64

func (f *FlexInt) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*f = 0
		return nil
	}
	s := strings.Trim(string(b), `"`)
	if s == "" {
		*f = 0
		return nil
	}
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		if fl, ferr := strconv.ParseFloat(s, 64); ferr == nil {
			*f = FlexInt(fl)
			return nil
		}
		*f = 0
		return nil
	}
	*f = FlexInt(n)
	return nil
}

// PaginationMeta is KPAX's Laravel-style page metadata.
type PaginationMeta struct {
	CurrentPage FlexInt `json:"current_page"`
	LastPage    FlexInt `json:"last_page"`
	PerPage     FlexInt `json:"per_page"`
	Total       FlexInt `json:"total"`
	From        FlexInt `json:"from"`
	To          FlexInt `json:"to"`
}

// Page is one page of a paginated listing.
type Page[T any] struct {
	Data  []T             `json:"data"`
	Meta  *PaginationMeta `json:"meta,omitempty"`
	Links map[string]any  `json:"links,omitempty"`
}

// Account is a KPAX account (hierarchy node).
type Account struct {
	ID             FlexInt         `json:"id"`
	Name           string          `json:"name"`
	ParentType     string          `json:"parent_type"`
	ParentID       FlexInt         `json:"parent_id"`
	ActivationCode string          `json:"activation_code"`
	Raw            json.RawMessage `json:"-"`
}

func (a *Account) UnmarshalJSON(b []byte) error {
	type plain Account
	if err := json.Unmarshal(b, (*plain)(a)); err != nil {
		return err
	}
	a.Raw = append(json.RawMessage(nil), b...)
	return nil
}

// Device holds the core device fields. A full device's meters, supplies,
// alerts, … are in Raw (decode with RawMap or your own struct).
type Device struct {
	ID                 FlexInt         `json:"id"`
	SerialNumber       string          `json:"serial_number"`
	SerialNumberOrigin string          `json:"serial_number_origin"`
	Manufacturer       string          `json:"manufacturer"`
	ManufacturerOrigin string          `json:"manufacturer_origin"`
	Model              string          `json:"model"`
	ModelOrigin        string          `json:"model_origin"`
	ParentType         string          `json:"parent_type"`
	ParentID           FlexInt         `json:"parent_id"`
	ProfileID          FlexInt         `json:"profile_id"`
	AgentID            FlexInt         `json:"agent_id"`
	MacAddress         string          `json:"mac_address"`
	Typology           string          `json:"typology"`
	LastCheck          string          `json:"last_check"`
	CreatedAt          string          `json:"created_at"`
	Raw                json.RawMessage `json:"-"`
}

func (d *Device) UnmarshalJSON(b []byte) error {
	type plain Device
	if err := json.Unmarshal(b, (*plain)(d)); err != nil {
		return err
	}
	d.Raw = append(json.RawMessage(nil), b...)
	return nil
}

// RawMap decodes Raw into a generic map.
func (d *Device) RawMap() (map[string]any, error) {
	var m map[string]any
	err := json.Unmarshal(d.Raw, &m)
	return m, err
}

// ServerStatus is the payload of GET /server/status.
type ServerStatus struct {
	Version        string          `json:"version"`
	TimezoneServer string          `json:"timezone_server"`
	DateServer     string          `json:"date_server"`
	Raw            json.RawMessage `json:"-"`
}

func (s *ServerStatus) UnmarshalJSON(b []byte) error {
	type plain ServerStatus
	if err := json.Unmarshal(b, (*plain)(s)); err != nil {
		return err
	}
	s.Raw = append(json.RawMessage(nil), b...)
	return nil
}

// AlertHistoryEvent is one technical alert occurrence window.
type AlertHistoryEvent struct {
	Value           string  `json:"value"`
	FirstTimeSeenOn string  `json:"first_time_seen_on"`
	LastTimeSeenOn  string  `json:"last_time_seen_on"`
	EventEndDate    *string `json:"event_end_date"`
	Occurrences     FlexInt `json:"occurrences"`
}

// RateLimit holds the last X-RateLimit-* values seen (B08). Reset is unix seconds.
type RateLimit struct {
	Limit     *int64
	Remaining *int64
	Reset     *int64
}

// ConnectionTestResult is returned by TestConnection and TestCredentials (B17).
type ConnectionTestResult struct {
	OK bool
	// Stage is "config", "auth" or "api" when OK is false.
	Stage     string
	Status    int
	Message   string
	LatencyMs int64
	Server    *ServerStatus
}

// Volumes maps volume name -> date -> count (B15).
type Volumes map[string]map[string]float64
