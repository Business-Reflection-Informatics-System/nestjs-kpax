using System.Text.Json;

namespace BizReflex.Kpax;

/// <summary>Base class for every exception thrown by this library.</summary>
public class KpaxException : Exception
{
    /// <inheritdoc />
    public KpaxException(string message, Exception? inner = null) : base(message, inner) { }
}

/// <summary>Invalid host or missing client id/secret (B10).</summary>
public sealed class KpaxConfigurationException : KpaxException
{
    /// <inheritdoc />
    public KpaxConfigurationException(string message) : base("KPAX: " + message) { }
}

/// <summary>The <c>/oauth/token</c> endpoint refused the credentials, or was unreachable (<see cref="Status"/> 0) (B05).</summary>
public sealed class KpaxAuthException : KpaxException
{
    /// <summary>HTTP status, or 0 when the endpoint could not be reached.</summary>
    public int Status { get; }
    /// <summary>Normalised host.</summary>
    public string Host { get; }
    /// <summary>Parsed response body (JSON element or string), if any.</summary>
    public object? Body { get; }

    internal KpaxAuthException(int status, string host, object? body, Exception? inner = null)
        : base($"KPAX token request to {host} failed with HTTP {status}{Describe.Body(body)}", inner)
    {
        Status = status;
        Host = host;
        Body = body;
    }
}

/// <summary>
/// KPAX answered with a non-2xx status after retries (B09). <see cref="Status"/> is 0 for a
/// network error that persisted through retries. KPAX uses 401 both for bad tokens and missing
/// scopes, and 403 for resources outside the API client's hierarchy level.
/// </summary>
public sealed class KpaxApiException : KpaxException
{
    /// <summary>HTTP status (0 = network error).</summary>
    public int Status { get; }
    /// <summary>HTTP method.</summary>
    public string Method { get; }
    /// <summary>Path relative to /api/v1.</summary>
    public string Path { get; }
    /// <summary>Parsed response body (JSON element or string), if any.</summary>
    public object? Body { get; }

    internal KpaxApiException(int status, string method, string path, object? body, string? message = null, Exception? inner = null)
        : base(message ?? $"KPAX {method} {path} failed with HTTP {status}{Describe.Body(body)}", inner)
    {
        Status = status;
        Method = method;
        Path = path;
        Body = body;
    }

    /// <summary>401: bad token or missing scope.</summary>
    public bool IsUnauthorized => Status == 401;
    /// <summary>403: resource outside the client's hierarchy level.</summary>
    public bool IsForbidden => Status == 403;
    /// <summary>404.</summary>
    public bool IsNotFound => Status == 404;
    /// <summary>429 after retries.</summary>
    public bool IsRateLimited => Status == 429;
}

internal static class Describe
{
    public static string Body(object? body)
    {
        switch (body)
        {
            case null:
                return "";
            case string s:
                return s.Length == 0 ? "" : ": " + (s.Length > 300 ? s[..300] : s);
            case JsonElement e when e.ValueKind == JsonValueKind.Object:
                foreach (var key in new[] { "message", "error_description", "error" })
                {
                    if (e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
                    {
                        return ": " + v.GetString();
                    }
                }
                break;
        }
        var raw = body is JsonElement je ? je.GetRawText() : JsonSerializer.Serialize(body);
        return ": " + (raw.Length > 300 ? raw[..300] : raw);
    }
}
