using BizReflex.Kpax;
var r = await KpaxClient.TestCredentialsAsync(new KpaxClientOptions { Host = "nope", ClientId = "a", ClientSecret = "b" });
Console.WriteLine($"installed nupkg works: stage={r.Stage}");
