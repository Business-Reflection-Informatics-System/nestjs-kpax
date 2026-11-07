using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BizReflex.Kpax.Tests;

[AttributeUsage(AttributeTargets.Method)]
public sealed class FactAttribute : Attribute { }

public sealed class AssertException(string message) : Exception(message);

public static class Assert
{
    public static void Equal<T>(T expected, T actual, string? what = null)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new AssertException($"{what ?? "value"}: expected <{expected}>, got <{actual}>");
    }

    public static void True(bool condition, string what)
    {
        if (!condition) throw new AssertException($"expected true: {what}");
    }

    public static async Task<T> ThrowsAsync<T>(Func<Task> action) where T : Exception
    {
        try
        {
            await action();
        }
        catch (T e)
        {
            return e;
        }
        catch (Exception e)
        {
            throw new AssertException($"expected {typeof(T).Name}, got {e.GetType().Name}: {e.Message}");
        }
        throw new AssertException($"expected {typeof(T).Name}, nothing thrown");
    }

    public static T Throws<T>(Action action) where T : Exception
    {
        try
        {
            action();
        }
        catch (T e)
        {
            return e;
        }
        catch (Exception e)
        {
            throw new AssertException($"expected {typeof(T).Name}, got {e.GetType().Name}: {e.Message}");
        }
        throw new AssertException($"expected {typeof(T).Name}, nothing thrown");
    }
}

public sealed record Call(string Method, Uri Uri, string? Authorization, string? Accept, string? ContentType, string Body);

/// <summary>A fake KPAX behind an HttpMessageHandler.</summary>
public sealed class MockKpax : HttpMessageHandler
{
    private int _seq;
    private int _gateOpen = 1;
    private readonly TaskCompletionSource _gate = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public List<Call> Calls { get; } = new();
    public List<Dictionary<string, string>> TokenRequests { get; } = new();
    public Func<Call, int, HttpResponseMessage> Handler { get; set; } = (_, _) => Json(Fixtures.Load("server-status.json"));
    public Func<HttpResponseMessage>? TokenHandler { get; set; }
    public Func<Call, Exception?>? Fault { get; set; }

    public void CloseGate() => _gateOpen = 0;
    public void OpenGate() { _gateOpen = 1; _gate.TrySetResult(); }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
        var call = new Call(
            request.Method.Method,
            request.RequestUri!,
            request.Headers.Authorization?.ToString(),
            request.Headers.Accept.ToString(),
            request.Content?.Headers.ContentType?.MediaType,
            body);

        if (request.RequestUri!.AbsolutePath == "/oauth/token")
        {
            if (_gateOpen == 0) await _gate.Task;
            lock (TokenRequests) TokenRequests.Add(ParseForm(body));
            if (TokenHandler is not null) return TokenHandler();
            var n = Interlocked.Increment(ref _seq);
            return Json(new JsonObject { ["token_type"] = "Bearer", ["expires_in"] = 3600, ["access_token"] = $"tok-{n}" });
        }

        int index;
        lock (Calls)
        {
            Calls.Add(call);
            index = Calls.Count;
        }
        if (Fault?.Invoke(call) is { } fault) throw fault;
        return Handler(call, index);
    }

    public static HttpResponseMessage Json(JsonNode? body, int status = 200, Dictionary<string, string>? headers = null)
    {
        var res = new HttpResponseMessage((HttpStatusCode)status)
        {
            Content = new StringContent(body?.ToJsonString() ?? "", Encoding.UTF8, "application/json"),
        };
        foreach (var (k, v) in headers ?? new())
        {
            res.Headers.TryAddWithoutValidation(k, v);
        }
        return res;
    }

    public static Dictionary<string, string> ParseForm(string body) =>
        body.Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2))
            .ToDictionary(p => Uri.UnescapeDataString(p[0].Replace('+', ' ')), p => p.Length > 1 ? Uri.UnescapeDataString(p[1].Replace('+', ' ')) : "");

    public static Dictionary<string, string> Query(Uri uri) => ParseForm(uri.Query.TrimStart('?'));
}

public static class Fixtures
{
    private static readonly string Dir = Find();

    private static string Find()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "fixtures");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(candidate, "token.json"))) return candidate;
            dir = dir.Parent;
        }
        throw new InvalidOperationException("fixtures/ not found");
    }

    public static JsonNode Load(string name) => JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, name)))!;
}

public sealed class FakeClock
{
    public DateTimeOffset Now = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);
    public List<TimeSpan> Sleeps { get; } = new();

    public Task Delay(TimeSpan d, CancellationToken _)
    {
        lock (Sleeps)
        {
            Sleeps.Add(d);
            Now += d;
        }
        return Task.CompletedTask;
    }
}

public static class Runner
{
    public static async Task<int> Main()
    {
        var tests = typeof(Runner).Assembly.GetTypes()
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
                .Where(m => m.GetCustomAttribute<FactAttribute>() is not null)
                .Select(m => (Type: t, Method: m)))
            .OrderBy(x => x.Method.Name, StringComparer.Ordinal)
            .ToList();

        var failed = 0;
        foreach (var (type, method) in tests)
        {
            var name = $"{type.Name}.{method.Name}";
            try
            {
                var instance = method.IsStatic ? null : Activator.CreateInstance(type);
                var result = method.Invoke(instance, null);
                if (result is Task task) await task;
                Console.WriteLine($"  PASS  {name}");
            }
            catch (Exception e)
            {
                failed++;
                var inner = e is TargetInvocationException tie ? tie.InnerException ?? e : e;
                Console.WriteLine($"  FAIL  {name}\n        {inner.GetType().Name}: {inner.Message}");
            }
        }
        Console.WriteLine($"\n{tests.Count - failed} passed, {failed} failed, {tests.Count} total");
        return failed == 0 ? 0 : 1;
    }
}
