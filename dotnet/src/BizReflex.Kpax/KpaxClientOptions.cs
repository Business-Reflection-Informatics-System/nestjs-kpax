namespace BizReflex.Kpax;

/// <summary>Configuration of a <see cref="KpaxClient"/>. Host, ClientId and ClientSecret are required.</summary>
public sealed class KpaxClientOptions
{
    /// <summary>Read scopes requested when <see cref="Scopes"/> is empty.</summary>
    public static readonly IReadOnlyList<string> DefaultScopes = new[]
    {
        "accounts:read", "agents:read", "devices:read", "hierarchy-elements:read",
        "dynamic-groups:read", "profiles:read", "rules:read", "labels:read", "server:read",
    };

    /// <summary>Instance URL, e.g. https://acme.kpax.cloud.</summary>
    public string Host { get; set; } = "";
    /// <summary>OAuth2 client id from the KPAX API panel.</summary>
    public string ClientId { get; set; } = "";
    /// <summary>OAuth2 client secret from the KPAX API panel.</summary>
    public string ClientSecret { get; set; } = "";
    /// <summary>Scopes to request. Default <see cref="DefaultScopes"/>.</summary>
    public IReadOnlyList<string>? Scopes { get; set; }
    /// <summary>Per-attempt timeout. Default 30 s.</summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);
    /// <summary>Max retries for 429 / 5xx / network errors. Default 4.</summary>
    public int MaxRetries { get; set; } = 4;
    /// <summary>Backoff base. Default 500 ms.</summary>
    public TimeSpan BaseDelay { get; set; } = TimeSpan.FromMilliseconds(500);
    /// <summary>Cap on any single wait, including Retry-After. Default 60 s.</summary>
    public TimeSpan MaxDelay { get; set; } = TimeSpan.FromSeconds(60);
    /// <summary>Refresh the token this long before it expires. Default 60 s.</summary>
    public TimeSpan TokenRefreshSkew { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>For tests: replaces Task.Delay.</summary>
    public Func<TimeSpan, CancellationToken, Task>? Delay { get; set; }
    /// <summary>For tests: replaces the system clock.</summary>
    public Func<DateTimeOffset>? Clock { get; set; }
}
