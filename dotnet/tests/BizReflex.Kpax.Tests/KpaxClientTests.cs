using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BizReflex.Kpax.Tests;

public sealed class KpaxClientTests
{
    private readonly MockKpax _mock = new();
    private readonly FakeClock _clock = new();

    private KpaxClient Client(Action<KpaxClientOptions>? configure = null)
    {
        var o = new KpaxClientOptions
        {
            Host = "https://acme.kpax.cloud/",
            ClientId = "cid",
            ClientSecret = "secret-1",
            BaseDelay = TimeSpan.FromMilliseconds(1),
            Delay = _clock.Delay,
            Clock = () => _clock.Now,
        };
        configure?.Invoke(o);
        return new KpaxClient(o, new HttpClient(_mock));
    }

    private static HttpResponseMessage Ok(string fixture) => MockKpax.Json(Fixtures.Load(fixture));

    [Fact] // B01 B02
    public async Task B01_ClientCredentialsAndBearer()
    {
        var status = await Client().GetServerStatusAsync();
        Assert.Equal("3.20.0", status.Version);
        var f = _mock.TokenRequests[0];
        Assert.Equal("client_credentials", f["grant_type"]);
        Assert.Equal("cid", f["client_id"]);
        Assert.Equal("secret-1", f["client_secret"]);
        Assert.Equal(string.Join(" ", KpaxClientOptions.DefaultScopes), f["scope"]);
        Assert.Equal("https://acme.kpax.cloud/api/v1/server/status", _mock.Calls[0].Uri.ToString());
        Assert.Equal("Bearer tok-1", _mock.Calls[0].Authorization);
        Assert.Equal("application/json", _mock.Calls[0].Accept);
    }

    [Fact] // B03
    public async Task B03_TokenCachedAndRefreshedBeforeExpiry()
    {
        var c = Client();
        await c.GetServerStatusAsync();
        await c.GetServerStatusAsync();
        Assert.Equal(1, _mock.TokenRequests.Count);
        _clock.Now += TimeSpan.FromSeconds(3600 - 60 + 1);
        await c.GetServerStatusAsync();
        Assert.Equal(2, _mock.TokenRequests.Count);
    }

    [Fact] // B03
    public async Task B03_ConcurrentCallersShareOneToken()
    {
        var c = Client();
        _mock.CloseGate();
        var tasks = Enumerable.Range(0, 5).Select(_ => c.GetServerStatusAsync()).ToList();
        await Task.Delay(50);
        _mock.OpenGate();
        await Task.WhenAll(tasks);
        Assert.Equal(1, _mock.TokenRequests.Count);
        Assert.Equal(5, _mock.Calls.Count);
    }

    [Fact] // B04
    public async Task B04_RefreshOnceOn401ThenSurface()
    {
        var c = Client();
        _mock.Handler = (_, n) => n == 1
            ? MockKpax.Json(new JsonObject { ["message"] = "Unauthenticated." }, 401)
            : Ok("server-status.json");
        await c.GetServerStatusAsync();
        Assert.Equal("Bearer tok-1", _mock.Calls[0].Authorization);
        Assert.Equal("Bearer tok-2", _mock.Calls[1].Authorization);

        _mock.Handler = (_, _) => MockKpax.Json(new JsonObject { ["message"] = "Invalid scope(s) provided." }, 401);
        var e = await Assert.ThrowsAsync<KpaxApiException>(() => c.GetServerStatusAsync());
        Assert.Equal(401, e.Status);
        Assert.True(e.IsUnauthorized && e.Message.Contains("Invalid scope"), "401 with KPAX message");
    }

    [Fact] // B05
    public async Task B05_TokenEndpointRefusal()
    {
        _mock.TokenHandler = () => MockKpax.Json(new JsonObject { ["error"] = "invalid_client" }, 401);
        var e = await Assert.ThrowsAsync<KpaxAuthException>(() => Client().GetServerStatusAsync());
        Assert.Equal(401, e.Status);
        Assert.True(e.Message.Contains("invalid_client"), "message has invalid_client");
    }

    [Fact] // B06
    public async Task B06_429WaitsRetryAfterForAnyMethod()
    {
        _mock.Handler = (_, n) => n == 1
            ? MockKpax.Json(new JsonObject(), 429, new() { ["Retry-After"] = "7" })
            : MockKpax.Json(new JsonObject { ["data"] = new JsonArray() });
        await Client().SearchDevicesAsync();
        Assert.Equal(2, _mock.Calls.Count);
        Assert.Equal(TimeSpan.FromSeconds(7), _clock.Sleeps[0]);
    }

    [Fact] // B07
    public async Task B07_5xxRetriedForGetNotPost()
    {
        var c = Client();
        _mock.Handler = (_, n) => n < 3 ? MockKpax.Json(new JsonObject(), 503) : Ok("server-status.json");
        await c.GetServerStatusAsync();
        Assert.Equal(3, _mock.Calls.Count);

        _mock.Calls.Clear();
        _mock.Handler = (_, _) => MockKpax.Json(new JsonObject { ["message"] = "boom" }, 502);
        var e = await Assert.ThrowsAsync<KpaxApiException>(() => c.SearchDevicesAsync());
        Assert.Equal(502, e.Status);
        Assert.Equal(1, _mock.Calls.Count);
    }

    [Fact] // B07
    public async Task B07_NetworkErrorRetriedForGet()
    {
        var c = Client();
        var first = true;
        _mock.Fault = _ =>
        {
            if (!first) return null;
            first = false;
            return new HttpRequestException("connection reset");
        };
        var s = await c.GetServerStatusAsync();
        Assert.Equal("3.20.0", s.Version);
        Assert.Equal(1, _clock.Sleeps.Count);
    }

    [Fact] // B07 B09
    public async Task B09_4xxNotRetriedAndErrorDetails()
    {
        _mock.Handler = (_, _) => MockKpax.Json(new JsonObject { ["message"] = "This action is unauthorized." }, 403);
        var e = await Assert.ThrowsAsync<KpaxApiException>(() => Client().GetDeviceAsync(42));
        Assert.True(e.IsForbidden, "forbidden");
        Assert.Equal("GET", e.Method);
        Assert.Equal("/devices/42", e.Path);
        Assert.Equal("This action is unauthorized.", ((JsonElement)e.Body!).GetProperty("message").GetString());
        Assert.Equal(1, _mock.Calls.Count);
    }

    [Fact] // B08
    public async Task B08_RateLimitExhaustedHoldsNextRequest()
    {
        var c = Client();
        var reset = _clock.Now.ToUnixTimeSeconds() + 5;
        _mock.Handler = (_, _) => MockKpax.Json(Fixtures.Load("server-status.json"), 200, new()
        {
            ["X-RateLimit-Limit"] = "60",
            ["X-RateLimit-Remaining"] = "0",
            ["X-RateLimit-Reset"] = reset.ToString(),
        });
        await c.GetServerStatusAsync();
        Assert.Equal(new RateLimit(60, 0, reset), c.LastRateLimit);
        await c.GetServerStatusAsync();
        Assert.Equal(1, _clock.Sleeps.Count);
        Assert.Equal(TimeSpan.FromSeconds(5), _clock.Sleeps[0]);
    }

    [Fact] // B10
    public void B10_ConfigurationValidation()
    {
        foreach (var (host, id, secret) in new[]
        {
            ("not a url", "a", "b"), ("ftp://x.kpax.cloud", "a", "b"), ("https://x.kpax.cloud", "a", " "), ("https://x.kpax.cloud", "", "b"),
        })
        {
            Assert.Throws<KpaxConfigurationException>(() => new KpaxClient(new KpaxClientOptions { Host = host, ClientId = id, ClientSecret = secret }));
        }
        using var c = new KpaxClient(new KpaxClientOptions { Host = " https://acme.kpax.cloud/api/v1/ ", ClientId = "a", ClientSecret = "b" });
        Assert.Equal("https://acme.kpax.cloud", c.Host);
    }

    [Fact] // B11 B12 B18
    public async Task B11_IterateDevicesAllPages()
    {
        _mock.Handler = (call, _) => Ok($"devices-page-{MockKpax.Query(call.Uri)["page"]}.json");
        var ids = new List<long?>();
        Device? first = null;
        await foreach (var d in Client().GetDevicesAsync(new DeviceListOptions { Scope = new Scope("account", 12, true) }))
        {
            first ??= d;
            ids.Add(d.Id);
        }
        Assert.Equal("1,2,3,4", string.Join(",", ids));
        Assert.Equal("TASKalfa 2554ci", first!.Model);
        var q = MockKpax.Query(_mock.Calls[0].Uri);
        Assert.Equal("parent_type=account,parent_id=12,with_children=true,schema=core,page=1,per_page=1000",
            string.Join(",", q.Select(kv => $"{kv.Key}={kv.Value}")));
    }

    [Fact] // B12
    public async Task B12_PerPageOnlyWithCoreSchema()
    {
        _mock.Handler = (_, _) => MockKpax.Json(new JsonObject { ["data"] = new JsonArray() });
        await Client().ListDevicesAsync(new DeviceListOptions { Schema = "full", PerPage = 500 });
        Assert.True(!MockKpax.Query(_mock.Calls[0].Uri).ContainsKey("per_page"), "no per_page");
    }

    [Fact] // B11 B18
    public async Task B11_IterateAccounts()
    {
        _mock.Handler = (call, _) => Ok($"accounts-page-{MockKpax.Query(call.Uri)["page"]}.json");
        var accounts = new List<Account>();
        await foreach (var a in Client().GetAccountsAsync()) accounts.Add(a);
        Assert.Equal("10,11,12", string.Join(",", accounts.Select(a => a.Id)));
        Assert.Equal(1L, accounts[1].ParentId);
    }

    [Fact] // B13
    public async Task B13_FindDeviceBySerial()
    {
        var c = Client();
        _mock.Handler = (_, _) => Ok("serial-search.json");
        Assert.Equal(7L, (await c.FindDeviceBySerialAsync(" abcd123456789 "))?.Id);
        Assert.Equal("ABCD123456789", MockKpax.Query(_mock.Calls[0].Uri)["serial_number"]);
        Assert.Equal(9L, (await c.FindDeviceBySerialAsync("xyz987654321"))?.Id);
        Assert.Equal(null, await c.FindDeviceBySerialAsync("ABCD12345678"));
        await Assert.ThrowsAsync<ArgumentException>(() => c.FindDeviceBySerialAsync("ABC"));
    }

    [Fact] // B13
    public async Task B13_AmbiguousSerial()
    {
        var dup = Fixtures.Load("serial-search.json");
        dup["data"]![1]!["serial_number"] = "ABCD123456789";
        _mock.Handler = (_, _) => MockKpax.Json(dup);
        var e = await Assert.ThrowsAsync<KpaxApiException>(() => Client().FindDeviceBySerialAsync("ABCD123456789"));
        Assert.Equal(409, e.Status);
    }

    [Fact] // B14
    public async Task B14_SearchDevicesForm()
    {
        _mock.Handler = (_, _) => MockKpax.Json(JsonNode.Parse("""{"data":[],"meta":{"current_page":1,"last_page":1}}"""));
        await Client().SearchDevicesAsync(new DeviceSearchOptions
        {
            Scope = new Scope("account", 3, true),
            Attributes = new[] { new AttributeRef("kpax.core.print.devices", "engine_count") },
            Filters = new[] { new SearchFilter("kpax.core.print.devices", "last_check", "greater", "2026-11-01 00:00:00") },
            AttributesWithLastCheck = false,
            ProfileIds = new long[] { 1, 4 },
            PerPage = 500,
        });
        var call = _mock.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.Equal("/api/v1/devices/search", call.Uri.AbsolutePath);
        Assert.Equal("application/x-www-form-urlencoded", call.ContentType);
        var f = MockKpax.ParseForm(call.Body);
        Assert.Equal("1", f["with_children"]);
        Assert.Equal("0", f["attributes_with_last_check"]);
        Assert.Equal("""[{"namespace":"kpax.core.print.devices","name":"engine_count"}]""", f["attributes"]);
        Assert.True(f["filters"].Contains("\"operator\":\"greater\""), "filter operator");
        Assert.Equal("1,4", f["profile_id"]);
        Assert.Equal("500", f["per_page"]);
    }

    [Fact] // B15
    public async Task B15_Volumes()
    {
        _mock.Handler = (_, _) => Ok("volumes.json");
        var v = await Client().GetDeviceVolumesAsync(42, new VolumeOptions("2026-11-01", "2026-11-02", VolumeName: "engine_count"));
        Assert.Equal(120d, v["engine_count"]["2026-11-01"]);
        Assert.Equal("/api/v1/devices/42/volumes", _mock.Calls[0].Uri.AbsolutePath);
        Assert.Equal("interval=daily,start_date=2026-11-01,end_date=2026-11-02,volume_name=engine_count",
            string.Join(",", MockKpax.Query(_mock.Calls[0].Uri).Select(kv => $"{kv.Key}={kv.Value}")));
    }

    [Fact] // B16
    public async Task B16_NullQueryOmittedAndPathEncoded()
    {
        var c = Client();
        _mock.Handler = (_, _) => Ok("supply-cycles.json");
        var cycles = await c.GetSupplyCyclesAsync(9, "black");
        Assert.Equal("TK-8345K", cycles[0].GetProperty("ref_part_number").GetString());
        Assert.Equal("?cartridge=black", _mock.Calls[0].Uri.Query);
        _mock.Handler = (_, _) => MockKpax.Json(new JsonObject());
        await c.SendAsync(HttpMethod.Get, "/devices/{id}", new KpaxRequest
        {
            PathParams = new Dictionary<string, object?> { ["id"] = "a/b" },
            Query = new Dictionary<string, object?> { ["x"] = null },
        });
        Assert.Equal("/api/v1/devices/a%2Fb", _mock.Calls[1].Uri.AbsolutePath);
        Assert.Equal("", _mock.Calls[1].Uri.Query);
    }

    [Fact] // B11
    public async Task B11_AlertHistoryAllPages()
    {
        _mock.Handler = (call, _) => Ok($"alerts-page-{MockKpax.Query(call.Uri)["page"]}.json");
        var events = await Client().GetTechnicalAlertHistoryAsync(42);
        Assert.Equal("Toner low,Paper jam", string.Join(",", events.Select(e => e.Value)));
        Assert.Equal(4L, events[0].Occurrences);
        Assert.Equal(null, events[1].EventEndDate);
    }

    [Fact]
    public async Task FullDeviceKeepsRaw()
    {
        _mock.Handler = (_, _) => Ok("device-full.json");
        var d = await Client().GetDeviceAsync(42);
        Assert.Equal("SN0000000042", d.SerialNumber);
        Assert.Equal(152340, d.Raw.GetProperty("meters").GetProperty("engine_count").GetProperty("value").GetInt32());
    }

    [Fact] // B17
    public async Task B17_TestConnectionNeverThrows()
    {
        var c = Client();
        Assert.True((await c.TestConnectionAsync()).Ok, "ok");
        _mock.TokenHandler = () => MockKpax.Json(new JsonObject { ["error"] = "invalid_client" }, 401);
        await c.ResetTokenAsync();
        var res = await c.TestConnectionAsync();
        Assert.Equal((false, "auth", (int?)401), (res.Ok, res.Stage, res.Status));
        var cfg = await KpaxClient.TestCredentialsAsync(new KpaxClientOptions { Host = "nope", ClientId = "a", ClientSecret = "b" });
        Assert.Equal("config", cfg.Stage);
    }

    [Fact]
    public async Task CancellationStopsRetries()
    {
        _mock.Handler = (_, _) => MockKpax.Json(new JsonObject(), 503);
        using var c = new KpaxClient(new KpaxClientOptions
        {
            Host = "https://acme.kpax.cloud", ClientId = "a", ClientSecret = "b", BaseDelay = TimeSpan.FromHours(1),
        }, new HttpClient(_mock));
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAsync<OperationCanceledException>(() => c.GetServerStatusAsync(cts.Token));
    }
}
