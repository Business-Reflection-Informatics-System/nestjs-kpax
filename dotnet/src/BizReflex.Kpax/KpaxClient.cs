using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BizReflex.Kpax;

/// <summary>
/// Client for one KPAX instance (KPAX API v1). Thread-safe: share one instance; callers share
/// one token. Behaviour ids (Bxx) refer to docs/client-behavior.md in the repository.
/// </summary>
public sealed class KpaxClient : IDisposable
{
    private static readonly HashSet<string> Idempotent = new(StringComparer.Ordinal) { "GET", "PUT", "DELETE" };

    internal static readonly JsonSerializerOptions Json = new()
    {
        NumberHandling = JsonNumberHandling.AllowReadingFromString, // B18
        PropertyNameCaseInsensitive = false,
    };

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly string _clientSecret;
    private readonly IReadOnlyList<string> _scopes;
    private readonly KpaxClientOptions _o;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<DateTimeOffset> _clock;
    private readonly SemaphoreSlim _tokenLock = new(1, 1);
    private readonly object _state = new();
    private readonly Random _random = new();

    private string? _token;
    private DateTimeOffset _tokenExpires;
    private DateTimeOffset _blockedUntil;
    private RateLimit? _lastRateLimit;

    /// <summary>Creates a client. Throws <see cref="KpaxConfigurationException"/> for invalid settings (B10).</summary>
    /// <param name="options">Connection and behaviour settings.</param>
    /// <param name="httpClient">Optional HttpClient (e.g. from IHttpClientFactory). Not disposed by this client.</param>
    public KpaxClient(KpaxClientOptions options, HttpClient? httpClient = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        _o = options;
        Host = NormalizeHost(options.Host);
        ClientId = (options.ClientId ?? "").Trim();
        _clientSecret = (options.ClientSecret ?? "").Trim();
        if (ClientId.Length == 0 || _clientSecret.Length == 0)
        {
            throw new KpaxConfigurationException($"connection for {Host} is missing ClientId or ClientSecret");
        }
        _scopes = options.Scopes is { Count: > 0 } s ? s : KpaxClientOptions.DefaultScopes;
        _http = httpClient ?? new HttpClient { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
        _ownsHttp = httpClient is null;
        _delay = options.Delay ?? ((d, ct) => Task.Delay(d, ct));
        _clock = options.Clock ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>Normalised instance URL.</summary>
    public string Host { get; }

    /// <summary>OAuth2 client id.</summary>
    public string ClientId { get; }

    /// <summary>Last X-RateLimit-* values seen (B08).</summary>
    public RateLimit? LastRateLimit
    {
        get { lock (_state) { return _lastRateLimit; } }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_ownsHttp)
        {
            _http.Dispose();
        }
        _tokenLock.Dispose();
    }

    // ------------------------------------------------------------ server / hierarchy

    /// <summary>GET /server/status.</summary>
    public async Task<ServerStatus> GetServerStatusAsync(CancellationToken ct = default)
        => ToModel<ServerStatus>(await SendAsync(HttpMethod.Get, "/server/status", null, ct).ConfigureAwait(false));

    /// <summary>Accounts, agents, devices and dynamic groups under a container (default: the client's own level).</summary>
    public Task<JsonElement> GetHierarchyAsync(string? objectType = null, long? objectId = null, CancellationToken ct = default)
        => SendAsync(HttpMethod.Get, "/hierarchy-elements",
            objectType is null ? null : new KpaxRequest { Query = Q(("object_type", objectType), ("object_id", objectId)) }, ct);

    // --------------------------------------------------------------------- accounts

    /// <summary>One page of accounts.</summary>
    public async Task<Page<Account>> ListAccountsAsync(AccountListOptions? options = null, CancellationToken ct = default)
    {
        var o = options ?? new AccountListOptions();
        var q = Q(("page", o.Page));
        if (o.ParentId is not null)
        {
            q["parent_type"] = "account";
            q["parent_id"] = o.ParentId;
            q["with_children"] = o.WithChildren;
        }
        return ToPage<Account>(await SendAsync(HttpMethod.Get, "/accounts", new KpaxRequest { Query = q }, ct).ConfigureAwait(false));
    }

    /// <summary>Every account across all pages.</summary>
    public IAsyncEnumerable<Account> GetAccountsAsync(AccountListOptions? options = null, CancellationToken ct = default)
        => PaginateAsync(p => ListAccountsAsync((options ?? new AccountListOptions()) with { Page = p }, ct), ct);

    /// <summary>One account.</summary>
    public async Task<Account> GetAccountAsync(long accountId, CancellationToken ct = default)
        => ToModel<Account>(await SendAsync(HttpMethod.Get, "/accounts/{id}", new KpaxRequest { PathParams = P(("id", accountId)) }, ct).ConfigureAwait(false));

    // ---------------------------------------------------------------------- devices

    /// <summary>One page of devices. PerPage (≤1000) only applies to the core schema (B12).</summary>
    public async Task<Page<Device>> ListDevicesAsync(DeviceListOptions? options = null, CancellationToken ct = default)
    {
        var o = options ?? new DeviceListOptions();
        var q = ScopeQuery(o.Scope);
        q["schema"] = o.Schema;
        q["sort"] = o.Sort;
        q["page"] = o.Page;
        q["per_page"] = o.Schema == "core" ? o.PerPage : null;
        return ToPage<Device>(await SendAsync(HttpMethod.Get, "/devices", new KpaxRequest { Query = q }, ct).ConfigureAwait(false));
    }

    /// <summary>Every device across all pages; 1000 per page on the core schema (B12).</summary>
    public IAsyncEnumerable<Device> GetDevicesAsync(DeviceListOptions? options = null, CancellationToken ct = default)
    {
        var o = options ?? new DeviceListOptions();
        if (o.PerPage is null && o.Schema == "core")
        {
            o = o with { PerPage = 1000 };
        }
        return PaginateAsync(p => ListDevicesAsync(o with { Page = p }, ct), ct);
    }

    /// <summary>Full device; meters, supplies, alerts, … are in <see cref="KpaxModel.Raw"/>.</summary>
    public async Task<Device> GetDeviceAsync(long deviceId, CancellationToken ct = default)
        => ToModel<Device>(await SendAsync(HttpMethod.Get, "/devices/{id}", new KpaxRequest { PathParams = P(("id", deviceId)) }, ct).ConfigureAwait(false));

    /// <summary>Partial serial search (≥5 characters), all pages.</summary>
    public async Task<IReadOnlyList<Device>> SearchDevicesBySerialAsync(string serial, Scope? scope = null, CancellationToken ct = default)
    {
        var s = (serial ?? "").Trim();
        if (s.Length < 5)
        {
            throw new ArgumentException("KPAX serial-number search needs at least 5 characters", nameof(serial));
        }
        var list = new List<Device>();
        await foreach (var d in PaginateAsync(async p =>
        {
            var q = ScopeQuery(scope, includeChildren: false);
            q["serial_number"] = s;
            q["page"] = p;
            return ToPage<Device>(await SendAsync(HttpMethod.Get, "/devices/search-by-serial-number", new KpaxRequest { Query = q }, ct).ConfigureAwait(false));
        }, ct).ConfigureAwait(false))
        {
            list.Add(d);
        }
        return list;
    }

    /// <summary>
    /// Exact, case-insensitive match on the effective or original serial (B13). Null when nothing
    /// matches; <see cref="KpaxApiException"/> with status 409 when several devices match.
    /// </summary>
    public async Task<Device?> FindDeviceBySerialAsync(string serial, Scope? scope = null, CancellationToken ct = default)
    {
        var want = (serial ?? "").Trim().ToUpperInvariant();
        var hits = (await SearchDevicesBySerialAsync(want, scope, ct).ConfigureAwait(false))
            .Where(d => Same(d.SerialNumber, want) || Same(d.SerialNumberOrigin, want))
            .ToList();
        if (hits.Count > 1)
        {
            throw new KpaxApiException(409, "GET", "/devices/search-by-serial-number",
                string.Join(",", hits.Select(h => h.Id)), $"Serial {want} matches {hits.Count} KPAX devices");
        }
        return hits.FirstOrDefault();

        static bool Same(string? v, string want) => v is not null && v.Trim().ToUpperInvariant() == want;
    }

    /// <summary>POST /devices/search: bulk read of chosen attributes across a fleet (B14).</summary>
    public async Task<Page<JsonElement>> SearchDevicesAsync(DeviceSearchOptions? options = null, CancellationToken ct = default)
    {
        var o = options ?? new DeviceSearchOptions();
        var form = new Dictionary<string, string>();
        if (o.Scope is { } s)
        {
            form["parent_type"] = s.ParentType;
            form["parent_id"] = s.ParentId.ToString(CultureInfo.InvariantCulture);
            if (s.WithChildren is { } wc) form["with_children"] = wc ? "1" : "0";
        }
        if (o.Attributes is { Count: > 0 }) form["attributes"] = JsonSerializer.Serialize(o.Attributes, Json);
        if (o.Filters is { Count: > 0 }) form["filters"] = JsonSerializer.Serialize(o.Filters, Json);
        if (o.AttributesWithLastCheck is { } lc) form["attributes_with_last_check"] = lc ? "1" : "0";
        if (o.ProfileIds is { Count: > 0 }) form["profile_id"] = string.Join(",", o.ProfileIds.Select(i => i.ToString(CultureInfo.InvariantCulture)));
        if (o.Sort is not null) form["sort"] = o.Sort;
        if (o.Page is { } page) form["page"] = page.ToString(CultureInfo.InvariantCulture);
        if (o.PerPage is { } pp) form["per_page"] = pp.ToString(CultureInfo.InvariantCulture);
        var body = await SendAsync(HttpMethod.Post, "/devices/search", new KpaxRequest { Form = form }, ct).ConfigureAwait(false);
        return ToPage(body, e => e.Clone());
    }

    /// <summary>Every page of <see cref="SearchDevicesAsync"/>.</summary>
    public IAsyncEnumerable<JsonElement> SearchAllDevicesAsync(DeviceSearchOptions? options = null, CancellationToken ct = default)
        => PaginateAsync(p => SearchDevicesAsync((options ?? new DeviceSearchOptions()) with { Page = p }, ct), ct);

    /// <summary>{volumeName: {date: count}} (B15).</summary>
    public async Task<Dictionary<string, Dictionary<string, double>>> GetDeviceVolumesAsync(long deviceId, VolumeOptions options, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        var body = await SendAsync(HttpMethod.Get, "/devices/{id}/volumes", new KpaxRequest
        {
            PathParams = P(("id", deviceId)),
            Query = Q(("interval", options.Interval), ("start_date", options.StartDate), ("end_date", options.EndDate), ("volume_name", options.VolumeName)),
        }, ct).ConfigureAwait(false);
        return body.ValueKind == JsonValueKind.Object
            ? body.Deserialize<Dictionary<string, Dictionary<string, double>>>(Json) ?? new()
            : new();
    }

    /// <summary>Daily snapshots of a device (JSON array).</summary>
    public Task<JsonElement> GetDeviceHistoryAsync(long deviceId, DateRange? range = null, CancellationToken ct = default)
        => SendAsync(HttpMethod.Get, "/devices/{id}/history", new KpaxRequest { PathParams = P(("id", deviceId)), Query = RangeQuery(range) }, ct);

    /// <summary>One attribute's values over time (JSON array).</summary>
    public Task<JsonElement> GetDeviceAttributeHistoryAsync(long deviceId, AttributeRef attribute, DateRange? range = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(attribute);
        var q = RangeQuery(range);
        q["namespace"] = attribute.Namespace;
        q["name"] = attribute.Name;
        return SendAsync(HttpMethod.Get, "/devices/{id}/attributes/history", new KpaxRequest { PathParams = P(("id", deviceId)), Query = q }, ct);
    }

    /// <summary>Toner cycles for black, cyan, magenta or yellow (JSON array).</summary>
    public Task<JsonElement> GetSupplyCyclesAsync(long deviceId, string cartridge, int? nbCycles = null, CancellationToken ct = default)
        => SendAsync(HttpMethod.Get, "/devices/{id}/supply-cycles", new KpaxRequest
        {
            PathParams = P(("id", deviceId)),
            Query = Q(("cartridge", cartridge), ("nb_cycles", nbCycles)),
        }, ct);

    /// <summary>A device's alert events, all pages.</summary>
    public async Task<IReadOnlyList<AlertHistoryEvent>> GetTechnicalAlertHistoryAsync(long deviceId, DateRange? range = null, CancellationToken ct = default)
    {
        var list = new List<AlertHistoryEvent>();
        await foreach (var e in PaginateAsync(async p =>
        {
            var q = RangeQuery(range);
            q["page"] = p;
            return ToPage<AlertHistoryEvent>(await SendAsync(HttpMethod.Get, "/devices/{id}/technical-status-events/history",
                new KpaxRequest { PathParams = P(("id", deviceId)), Query = q }, ct).ConfigureAwait(false));
        }, ct).ConfigureAwait(false))
        {
            list.Add(e);
        }
        return list;
    }

    /// <summary>The device attribute catalogue.</summary>
    public Task<JsonElement> ListDeviceAttributesAsync(string? filter = null, string? locale = null, CancellationToken ct = default)
        => SendAsync(HttpMethod.Get, "/devices/attributes", new KpaxRequest { Query = Q(("filter", filter), ("locale", locale)) }, ct);

    /// <summary>Device profiles.</summary>
    public Task<JsonElement> ListProfilesAsync(CancellationToken ct = default)
        => SendAsync(HttpMethod.Get, "/profiles", null, ct);

    // -------------------------------------------------------------- connection test

    /// <summary>Token + GET /server/status. Never throws for KPAX/network failures (B17).</summary>
    public async Task<ConnectionTestResult> TestConnectionAsync(CancellationToken ct = default)
    {
        var start = _clock();
        try
        {
            var s = await GetServerStatusAsync(ct).ConfigureAwait(false);
            return new ConnectionTestResult { Ok = true, LatencyMs = Ms(start), Server = s };
        }
        catch (KpaxAuthException e)
        {
            return new ConnectionTestResult { Stage = "auth", Status = e.Status, Message = e.Message, LatencyMs = Ms(start) };
        }
        catch (KpaxApiException e)
        {
            return new ConnectionTestResult { Stage = "api", Status = e.Status, Message = e.Message, LatencyMs = Ms(start) };
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return new ConnectionTestResult { Stage = "api", Message = e.Message, LatencyMs = Ms(start) };
        }
    }

    /// <summary>Like <see cref="TestConnectionAsync"/>, also reporting invalid settings as stage "config".</summary>
    public static async Task<ConnectionTestResult> TestCredentialsAsync(KpaxClientOptions options, HttpClient? httpClient = null, CancellationToken ct = default)
    {
        KpaxClient client;
        try
        {
            client = new KpaxClient(options, httpClient);
        }
        catch (KpaxConfigurationException e)
        {
            return new ConnectionTestResult { Stage = "config", Message = e.Message };
        }
        using (client)
        {
            return await client.TestConnectionAsync(ct).ConfigureAwait(false);
        }
    }

    // -------------------------------------------------------------------- transport

    /// <summary>
    /// Calls any KPAX v1 endpoint (path relative to /api/v1, with {name} placeholders) with auth,
    /// retries and rate-limit handling. Returns the parsed JSON body (Undefined when empty).
    /// </summary>
    public async Task<JsonElement> SendAsync(HttpMethod method, string path, KpaxRequest? request = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(method);
        var m = method.Method.ToUpperInvariant();
        var resolved = Interpolate(path, request?.PathParams);
        var (status, text) = await SendWithRetriesAsync(m, resolved, request, ct).ConfigureAwait(false);
        var body = Parse(text);
        if (status < 200 || status >= 300)
        {
            throw new KpaxApiException(status, m, resolved, BodyObject(body, text));
        }
        return body;
    }

    /// <summary>Like <see cref="SendAsync"/>, deserialising the body to <typeparamref name="T"/>.</summary>
    public async Task<T?> SendAsync<T>(HttpMethod method, string path, KpaxRequest? request = null, CancellationToken ct = default)
    {
        var body = await SendAsync(method, path, request, ct).ConfigureAwait(false);
        return body.ValueKind == JsonValueKind.Undefined ? default : body.Deserialize<T>(Json);
    }

    private async Task<(int Status, string Text)> SendWithRetriesAsync(string method, string path, KpaxRequest? request, CancellationToken ct)
    {
        var url = Host + "/api/v1" + path + EncodeQuery(request?.Query);
        var attempt = 0;
        var refreshed = false;

        while (true)
        {
            var wait = BlockedFor();
            if (wait > TimeSpan.Zero)
            {
                await _delay(Min(wait, _o.MaxDelay), ct).ConfigureAwait(false);
            }

            var token = await GetTokenAsync(ct).ConfigureAwait(false);
            HttpResponseMessage? res = null;
            string text;
            try
            {
                using var msg = new HttpRequestMessage(new HttpMethod(method), url);
                msg.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                if (request?.Form is { } form)
                {
                    msg.Content = new FormUrlEncodedContent(form);
                }
                else if (request?.Json is { } json)
                {
                    msg.Content = new StringContent(JsonSerializer.Serialize(json, Json), Encoding.UTF8, "application/json");
                }
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(_o.Timeout);
                res = await _http.SendAsync(msg, cts.Token).ConfigureAwait(false);
                text = await res.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (IsTransient(e, ct))
            {
                res?.Dispose();
                if (Idempotent.Contains(method) && attempt < _o.MaxRetries) // B07
                {
                    await _delay(Backoff(attempt), ct).ConfigureAwait(false);
                    attempt++;
                    continue;
                }
                throw new KpaxApiException(0, method, path, e.Message, inner: e);
            }

            using (res)
            {
                TrackRateLimit(res);
                var status = (int)res.StatusCode;

                if (status == 401 && !refreshed) // B04
                {
                    refreshed = true;
                    await InvalidateTokenAsync().ConfigureAwait(false);
                    continue;
                }
                if (status == 429 && attempt < _o.MaxRetries) // B06
                {
                    var delay = Min(RetryAfter(res) ?? Backoff(attempt), _o.MaxDelay);
                    attempt++;
                    Block(_clock() + delay);
                    await _delay(delay, ct).ConfigureAwait(false);
                    continue;
                }
                if (status >= 500 && Idempotent.Contains(method) && attempt < _o.MaxRetries) // B07
                {
                    await _delay(Backoff(attempt), ct).ConfigureAwait(false);
                    attempt++;
                    continue;
                }
                return (status, text);
            }
        }
    }

    // ------------------------------------------------------------------------ token

    private async Task<string> GetTokenAsync(CancellationToken ct)
    {
        await _tokenLock.WaitAsync(ct).ConfigureAwait(false); // B03: one fetch for concurrent callers
        try
        {
            if (_token is not null && _clock() < _tokenExpires)
            {
                return _token;
            }
            var form = new Dictionary<string, string>
            {
                ["grant_type"] = "client_credentials",
                ["client_id"] = ClientId,
                ["client_secret"] = _clientSecret,
                ["scope"] = string.Join(" ", _scopes),
            };
            HttpResponseMessage res;
            string text;
            try
            {
                using var msg = new HttpRequestMessage(HttpMethod.Post, Host + "/oauth/token") { Content = new FormUrlEncodedContent(form) };
                msg.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(_o.Timeout);
                res = await _http.SendAsync(msg, cts.Token).ConfigureAwait(false);
                text = await res.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (IsTransient(e, ct))
            {
                throw new KpaxAuthException(0, Host, e.Message, e);
            }
            using (res)
            {
                var body = Parse(text);
                if (!res.IsSuccessStatusCode) // B05
                {
                    throw new KpaxAuthException((int)res.StatusCode, Host, BodyObject(body, text));
                }
                if (body.ValueKind != JsonValueKind.Object
                    || !body.TryGetProperty("access_token", out var at)
                    || at.ValueKind != JsonValueKind.String)
                {
                    throw new KpaxAuthException((int)res.StatusCode, Host, "Token response did not include access_token");
                }
                var ttl = body.TryGetProperty("expires_in", out var ei) && ei.TryGetDouble(out var secs) && secs > 0 ? secs : 3600;
                var life = TimeSpan.FromSeconds(ttl) - _o.TokenRefreshSkew;
                _token = at.GetString()!;
                _tokenExpires = _clock() + (life > TimeSpan.Zero ? life : TimeSpan.Zero);
                return _token;
            }
        }
        finally
        {
            _tokenLock.Release();
        }
    }

    private async Task InvalidateTokenAsync()
    {
        await _tokenLock.WaitAsync().ConfigureAwait(false);
        try
        {
            _token = null;
            _tokenExpires = default;
        }
        finally
        {
            _tokenLock.Release();
        }
    }

    /// <summary>For tests: forget the cached token.</summary>
    internal Task ResetTokenAsync() => InvalidateTokenAsync();

    // ------------------------------------------------------------------ rate limits

    private TimeSpan BlockedFor()
    {
        lock (_state) { return _blockedUntil - _clock(); }
    }

    private void Block(DateTimeOffset until)
    {
        lock (_state)
        {
            if (until > _blockedUntil) _blockedUntil = until;
        }
    }

    private void TrackRateLimit(HttpResponseMessage res)
    {
        var limit = IntHeader(res, "X-RateLimit-Limit");
        var remaining = IntHeader(res, "X-RateLimit-Remaining");
        var reset = IntHeader(res, "X-RateLimit-Reset");
        if (limit is null && remaining is null && reset is null) return;
        lock (_state) { _lastRateLimit = new RateLimit(limit, remaining, reset); }
        if (remaining == 0 && reset is > 0) // B08
        {
            Block(DateTimeOffset.FromUnixTimeSeconds(reset.Value));
        }
    }

    private TimeSpan? RetryAfter(HttpResponseMessage res)
    {
        if (res.Headers.RetryAfter is { } ra)
        {
            if (ra.Delta is { } delta) return delta < TimeSpan.Zero ? TimeSpan.Zero : delta;
            if (ra.Date is { } date) return Max(date - _clock(), TimeSpan.Zero);
        }
        if (IntHeader(res, "X-RateLimit-Reset") is { } reset)
        {
            return Max(DateTimeOffset.FromUnixTimeSeconds(reset) - _clock(), TimeSpan.Zero);
        }
        return null;
    }

    private TimeSpan Backoff(int attempt)
    {
        double exp = _o.BaseDelay.TotalMilliseconds * Math.Pow(2, attempt);
        double r;
        lock (_random) { r = _random.NextDouble(); }
        return Min(TimeSpan.FromMilliseconds(exp / 2 + r * exp / 2), _o.MaxDelay);
    }

    // ---------------------------------------------------------------------- helpers

    private async IAsyncEnumerable<T> PaginateAsync<T>(Func<int, Task<Page<T>>> fetch, [EnumeratorCancellation] CancellationToken ct)
    {
        var page = 1; // B11
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var res = await fetch(page).ConfigureAwait(false);
            foreach (var item in res.Data) yield return item;
            if (res.Data.Count == 0 || res.Meta is null) yield break;
            var current = res.Meta.CurrentPage ?? page;
            var last = res.Meta.LastPage ?? current;
            if (current >= last) yield break;
            page = (int)current + 1;
        }
    }

    private static Page<T> ToPage<T>(JsonElement body) where T : KpaxModel
        => ToPage(body, ToModel<T>);

    private static Page<T> ToPage<T>(JsonElement body, Func<JsonElement, T> convert)
    {
        if (body.ValueKind != JsonValueKind.Object) return new Page<T>(Array.Empty<T>(), null);
        var data = new List<T>();
        if (body.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in d.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Object) data.Add(convert(item));
            }
        }
        PaginationMeta? meta = body.TryGetProperty("meta", out var m) && m.ValueKind == JsonValueKind.Object
            ? m.Deserialize<PaginationMeta>(Json)
            : null;
        return new Page<T>(data, meta);
    }

    private static T ToModel<T>(JsonElement e) where T : KpaxModel
    {
        var model = e.ValueKind == JsonValueKind.Object ? e.Deserialize<T>(Json) : null;
        model ??= (T)Activator.CreateInstance(typeof(T), nonPublic: true)!;
        model.Raw = e.Clone();
        return model;
    }

    private static Dictionary<string, object?> ScopeQuery(Scope? s, bool includeChildren = true)
    {
        var q = new Dictionary<string, object?>();
        if (s is null) return q;
        q["parent_type"] = s.ParentType;
        q["parent_id"] = s.ParentId;
        if (includeChildren && s.ParentType == "account") q["with_children"] = s.WithChildren;
        return q;
    }

    private static Dictionary<string, object?> RangeQuery(DateRange? r)
        => r is null ? new() : Q(("start_date", r.StartDate), ("end_date", r.EndDate), ("sort", r.Sort));

    private static Dictionary<string, object?> Q(params (string Key, object? Value)[] items)
    {
        var d = new Dictionary<string, object?>();
        foreach (var (k, v) in items) d[k] = v;
        return d;
    }

    private static Dictionary<string, object?> P(params (string Key, object? Value)[] items) => Q(items);

    internal static string NormalizeHost(string? host)
    {
        var h = (host ?? "").Trim().TrimEnd('/');
        if (h.EndsWith("/api/v1", StringComparison.OrdinalIgnoreCase)) h = h[..^"/api/v1".Length].TrimEnd('/');
        if (!Uri.TryCreate(h, UriKind.Absolute, out var u) || (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) || string.IsNullOrEmpty(u.Host))
        {
            throw new KpaxConfigurationException($"host is not a valid http(s) URL: \"{h}\"");
        }
        return h;
    }

    private static string Interpolate(string path, IReadOnlyDictionary<string, object?>? pathParams)
    {
        var sb = new StringBuilder();
        var i = 0;
        while (i < path.Length)
        {
            var open = path.IndexOf('{', i);
            if (open < 0) { sb.Append(path, i, path.Length - i); break; }
            var close = path.IndexOf('}', open);
            if (close < 0) throw new ArgumentException($"Unterminated placeholder in {path}", nameof(path));
            var name = path[(open + 1)..close];
            object? v = null;
            if (pathParams is null || !pathParams.TryGetValue(name, out v) || v is null || Format(v) == "")
            {
                throw new ArgumentException($"Missing path parameter \"{name}\" for {path}", nameof(pathParams));
            }
            sb.Append(path, i, open - i).Append(Uri.EscapeDataString(Format(v)));
            i = close + 1;
        }
        return sb.ToString();
    }

    private static string EncodeQuery(IReadOnlyDictionary<string, object?>? q) // B16
    {
        if (q is null) return "";
        var parts = q.Where(kv => kv.Value is not null)
            .Select(kv => Uri.EscapeDataString(kv.Key) + "=" + Uri.EscapeDataString(Format(kv.Value!)))
            .ToList();
        return parts.Count == 0 ? "" : "?" + string.Join("&", parts);
    }

    private static string Format(object v) => v switch
    {
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString() ?? "",
    };

    private static JsonElement Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return default;
        try
        {
            using var doc = JsonDocument.Parse(text);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static object? BodyObject(JsonElement parsed, string text)
        => parsed.ValueKind != JsonValueKind.Undefined ? parsed : (string.IsNullOrEmpty(text) ? null : text);

    private static long? IntHeader(HttpResponseMessage res, string name)
    {
        if (!res.Headers.TryGetValues(name, out var values)) return null;
        var s = values.FirstOrDefault();
        return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? (long)d : null;
    }

    private static bool IsTransient(Exception e, CancellationToken ct) => e switch
    {
        HttpRequestException => true,
        IOException => true,
        OperationCanceledException => !ct.IsCancellationRequested, // per-attempt timeout, not the caller's token
        _ => false,
    };

    private long Ms(DateTimeOffset start) => (long)(_clock() - start).TotalMilliseconds;
    private static TimeSpan Min(TimeSpan a, TimeSpan b) => a < b ? a : b;
    private static TimeSpan Max(TimeSpan a, TimeSpan b) => a > b ? a : b;
}
