# Example Stack Profile - ASP.NET Core Razor Pages + htmx

This is the source project's stack extracted as an example adapter. Use it as a model for
other stacks; do not treat it as universal.

```yaml
stack:
  status: "example"
  name: "ASP.NET Core Razor Pages + htmx + EF Core SQLite"
  runtime: ".NET 8"
  framework: "ASP.NET Core 8 Razor Pages"
  frontend: "server-rendered Razor + htmx"
  persistence: "EF Core 8 + SQLite"
  package_manager: "dotnet CLI"
  build_command: "dotnet build"
  test_command: "dotnet test"
  migration_tool: "dotnet ef migrations"
```

## Architecture Adapter

| Universal principle | ASP.NET adapter |
|---|---|
| Framework entry points stay thin | Razor Page handlers should orchestrate only; non-trivial logic goes to services/application layer. |
| Production/test composition parity | When changing `Program.cs` DI/auth/localization, audit the test host factory for equivalent setup. |
| User-visible copy follows locale policy | Use `IStringLocalizer` and `.resx`; update every configured locale. |
| UI changes require rendered verification | Use browser/screenshot verification for Razor/htmx changes. |
| Schema changes use migration tool | Use EF Core migrations; document backfill/data-loss implications. |
| External APIs require primary-source docs | Check NuGet and maintainer docs/source before using package APIs. |

## Example Rules That Should Stay Project-Specific

- macOS LAN deployment;
- single user;
- SQLite DB path;
- FR/ZH/EN locale policy;
- no SPA/no Node build;
- Chart.js via CDN;
- local photo storage path;
- launch-profile names and ports.

Those belong in `profiles/project.md` or a project-specific `profiles/stack.md`,
not in the universal template.
