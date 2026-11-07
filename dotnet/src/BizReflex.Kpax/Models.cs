using System.Text.Json;
using System.Text.Json.Serialization;

namespace BizReflex.Kpax;

/// <summary>KPAX's Laravel-style page metadata.</summary>
public sealed record PaginationMeta
{
    /// <summary>Current page (1-based).</summary>
    [JsonPropertyName("current_page")] public long? CurrentPage { get; init; }
    /// <summary>Last page.</summary>
    [JsonPropertyName("last_page")] public long? LastPage { get; init; }
    /// <summary>Items per page.</summary>
    [JsonPropertyName("per_page")] public long? PerPage { get; init; }
    /// <summary>Total items.</summary>
    [JsonPropertyName("total")] public long? Total { get; init; }
    /// <summary>First item index on this page.</summary>
    [JsonPropertyName("from")] public long? From { get; init; }
    /// <summary>Last item index on this page.</summary>
    [JsonPropertyName("to")] public long? To { get; init; }
}

/// <summary>One page of a paginated listing.</summary>
public sealed record Page<T>(IReadOnlyList<T> Data, PaginationMeta? Meta);

/// <summary>Base for models that keep the JSON they were read from.</summary>
public abstract record KpaxModel
{
    /// <summary>The full JSON object this model was built from.</summary>
    [JsonIgnore] public JsonElement Raw { get; internal set; }
}

/// <summary>A KPAX account (hierarchy node).</summary>
public sealed record Account : KpaxModel
{
    /// <summary>Id.</summary>
    [JsonPropertyName("id")] public long? Id { get; init; }
    /// <summary>Name.</summary>
    [JsonPropertyName("name")] public string? Name { get; init; }
    /// <summary>Parent container type.</summary>
    [JsonPropertyName("parent_type")] public string? ParentType { get; init; }
    /// <summary>Parent id.</summary>
    [JsonPropertyName("parent_id")] public long? ParentId { get; init; }
    /// <summary>Agent activation code.</summary>
    [JsonPropertyName("activation_code")] public string? ActivationCode { get; init; }
}

/// <summary>Core device fields. A full device's meters, supplies, alerts, … are in <see cref="KpaxModel.Raw"/>.</summary>
public sealed record Device : KpaxModel
{
    /// <summary>Id.</summary>
    [JsonPropertyName("id")] public long? Id { get; init; }
    /// <summary>Effective serial number (may be overridden in KPAX).</summary>
    [JsonPropertyName("serial_number")] public string? SerialNumber { get; init; }
    /// <summary>Serial number reported by the device.</summary>
    [JsonPropertyName("serial_number_origin")] public string? SerialNumberOrigin { get; init; }
    /// <summary>Effective manufacturer.</summary>
    [JsonPropertyName("manufacturer")] public string? Manufacturer { get; init; }
    /// <summary>Manufacturer reported by the device.</summary>
    [JsonPropertyName("manufacturer_origin")] public string? ManufacturerOrigin { get; init; }
    /// <summary>Effective model.</summary>
    [JsonPropertyName("model")] public string? Model { get; init; }
    /// <summary>Model reported by the device.</summary>
    [JsonPropertyName("model_origin")] public string? ModelOrigin { get; init; }
    /// <summary>Parent container type.</summary>
    [JsonPropertyName("parent_type")] public string? ParentType { get; init; }
    /// <summary>Parent id.</summary>
    [JsonPropertyName("parent_id")] public long? ParentId { get; init; }
    /// <summary>Profile id.</summary>
    [JsonPropertyName("profile_id")] public long? ProfileId { get; init; }
    /// <summary>Agent id.</summary>
    [JsonPropertyName("agent_id")] public long? AgentId { get; init; }
    /// <summary>MAC address.</summary>
    [JsonPropertyName("mac_address")] public string? MacAddress { get; init; }
    /// <summary>Device typology.</summary>
    [JsonPropertyName("typology")] public string? Typology { get; init; }
    /// <summary>Last check (UTC, "YYYY-MM-DD HH:mm:ss").</summary>
    [JsonPropertyName("last_check")] public string? LastCheck { get; init; }
    /// <summary>Created at (UTC).</summary>
    [JsonPropertyName("created_at")] public string? CreatedAt { get; init; }
}

/// <summary>Payload of GET /server/status.</summary>
public sealed record ServerStatus : KpaxModel
{
    /// <summary>KPAX version.</summary>
    [JsonPropertyName("version")] public string? Version { get; init; }
    /// <summary>Server timezone.</summary>
    [JsonPropertyName("timezone_server")] public string? TimezoneServer { get; init; }
    /// <summary>Server date.</summary>
    [JsonPropertyName("date_server")] public string? DateServer { get; init; }
}

/// <summary>One technical alert occurrence window.</summary>
public sealed record AlertHistoryEvent : KpaxModel
{
    /// <summary>Alert text.</summary>
    [JsonPropertyName("value")] public string? Value { get; init; }
    /// <summary>First seen (UTC).</summary>
    [JsonPropertyName("first_time_seen_on")] public string? FirstTimeSeenOn { get; init; }
    /// <summary>Last seen (UTC).</summary>
    [JsonPropertyName("last_time_seen_on")] public string? LastTimeSeenOn { get; init; }
    /// <summary>End date, null while ongoing.</summary>
    [JsonPropertyName("event_end_date")] public string? EventEndDate { get; init; }
    /// <summary>Occurrences.</summary>
    [JsonPropertyName("occurrences")] public long? Occurrences { get; init; }
}

/// <summary>Last X-RateLimit-* values seen (B08). <see cref="Reset"/> is unix seconds.</summary>
public sealed record RateLimit(long? Limit, long? Remaining, long? Reset);

/// <summary>Result of <see cref="KpaxClient.TestConnectionAsync"/> (B17).</summary>
public sealed record ConnectionTestResult
{
    /// <summary>True when a token was obtained and /server/status answered.</summary>
    public bool Ok { get; init; }
    /// <summary>"config", "auth" or "api" when <see cref="Ok"/> is false.</summary>
    public string? Stage { get; init; }
    /// <summary>HTTP status of the failure, if any.</summary>
    public int? Status { get; init; }
    /// <summary>Failure message.</summary>
    public string? Message { get; init; }
    /// <summary>Elapsed milliseconds.</summary>
    public long LatencyMs { get; init; }
    /// <summary>Server status when ok.</summary>
    public ServerStatus? Server { get; init; }
}

/// <summary>Limits a listing to a hierarchy container.</summary>
/// <param name="ParentType">"account" or "dynamic_group".</param>
/// <param name="ParentId">Container id.</param>
/// <param name="WithChildren">Include sub-accounts (accounts only).</param>
public sealed record Scope(string ParentType, long ParentId, bool? WithChildren = null);

/// <summary>Options for <see cref="KpaxClient.ListAccountsAsync"/>.</summary>
public sealed record AccountListOptions
{
    /// <summary>List under this account.</summary>
    public long? ParentId { get; init; }
    /// <summary>Include sub-accounts.</summary>
    public bool? WithChildren { get; init; }
    /// <summary>Page (1-based).</summary>
    public int? Page { get; init; }
}

/// <summary>Options for <see cref="KpaxClient.ListDevicesAsync"/> (B12).</summary>
public sealed record DeviceListOptions
{
    /// <summary>Hierarchy container.</summary>
    public Scope? Scope { get; init; }
    /// <summary>"core" (default) or "full".</summary>
    public string Schema { get; init; } = "core";
    /// <summary>Page (1-based).</summary>
    public int? Page { get; init; }
    /// <summary>1–1000; core schema only.</summary>
    public int? PerPage { get; init; }
    /// <summary>manufacturer, -manufacturer, model, -model, created_at, -created_at.</summary>
    public string? Sort { get; init; }
}

/// <summary>A device attribute, e.g. ("kpax.core.print.devices", "engine_count").</summary>
public sealed record AttributeRef(
    [property: JsonPropertyName("namespace")] string Namespace,
    [property: JsonPropertyName("name")] string Name);

/// <summary>Filter for POST /devices/search; only last_check and serial_number are filterable.</summary>
public sealed record SearchFilter(
    [property: JsonPropertyName("namespace")] string Namespace,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("operator")] string Operator,
    [property: JsonPropertyName("value")] string Value);

/// <summary>Options for <see cref="KpaxClient.SearchDevicesAsync"/> (B14).</summary>
public sealed record DeviceSearchOptions
{
    /// <summary>Hierarchy container.</summary>
    public Scope? Scope { get; init; }
    /// <summary>Attributes to return.</summary>
    public IReadOnlyList<AttributeRef>? Attributes { get; init; }
    /// <summary>Filters.</summary>
    public IReadOnlyList<SearchFilter>? Filters { get; init; }
    /// <summary>Include last_check per attribute.</summary>
    public bool? AttributesWithLastCheck { get; init; }
    /// <summary>Profile ids.</summary>
    public IReadOnlyList<long>? ProfileIds { get; init; }
    /// <summary>Sort.</summary>
    public string? Sort { get; init; }
    /// <summary>Page (1-based).</summary>
    public int? Page { get; init; }
    /// <summary>Items per page.</summary>
    public int? PerPage { get; init; }
}

/// <summary>Inputs of <see cref="KpaxClient.GetDeviceVolumesAsync"/> (B15). Dates are YYYY-MM-DD, UTC.</summary>
public sealed record VolumeOptions(string StartDate, string EndDate, string Interval = "daily", string? VolumeName = null);

/// <summary>Optional date bounds for history calls; Sort is "asc" or "desc".</summary>
public sealed record DateRange(string? StartDate = null, string? EndDate = null, string? Sort = null);

/// <summary>Body/query/path inputs for <see cref="KpaxClient.SendAsync"/>.</summary>
public sealed record KpaxRequest
{
    /// <summary>Fills {name} placeholders (URL-encoded).</summary>
    public IReadOnlyDictionary<string, object?>? PathParams { get; init; }
    /// <summary>Query parameters; nulls omitted, bools as true/false (B16).</summary>
    public IReadOnlyDictionary<string, object?>? Query { get; init; }
    /// <summary>JSON body.</summary>
    public object? Json { get; init; }
    /// <summary>Form-encoded body (takes precedence over <see cref="Json"/>).</summary>
    public IReadOnlyDictionary<string, string>? Form { get; init; }
}
