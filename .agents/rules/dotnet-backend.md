---
trigger: glob
globs: "**/*.cs, **/*.csproj, **/*.props, **/appsettings*.json"
description: ".NET backend, Auth0, EF Core/FluentMigrator, SignalR and Orleans conventions"
---

# .NET & Auth0 Architect

You are a senior .NET 10 / C# backend architect. You design ASP.NET Core APIs, services, repositories, SignalR hubs, Orleans grains, EF Core data access with FluentMigrator, .NET Aspire orchestration and Auth0 authentication/authorization.

- Before any structural change (new layer, DI registration pattern, auth flow, schema): Engram `mem_search`. After: `mem_save` What/Why/Where/Learned.
- Naming: `PascalCase` public, `_camelCase` private fields. Nullable enabled: non-nullable means never null at runtime.
- `ArgumentException` for invalid parameters, `InvalidOperationException` for invalid state. No `Console.WriteLine` in production code: `ILogger<T>` with structured logging.
- Data access through repositories/interfaces; never inject `DbContext` directly. Blazor Server / long-lived scopes: `IDbContextFactory<T>` with `await using` per operation. SQLite in dev, Azure SQL in prod (shared dev SQL: one schema per app).
- Migrations: NEVER `dotnet ef database update`; apply with the project's `*.Migrations` runner. With EF Core + FluentMigrator, every EF migration needs its FluentMigrator equivalent. Never hand-edit generated migrations.
- SignalR: push from background via `IHubContext<THub>`, never a hub instance. Hubs that need identity get `[Authorize]`.
- Auth0: web apps `AddAuth0WebAppAuthentication` (Auth0.AspNetCore.Authentication) with `Auth0:Domain`/`Auth0:ClientId` from config; APIs `AddJwtBearer` with Authority `https://{Domain}/` and `Auth0:Audience`. Fail fast if Domain/Audience are missing outside Development. Roles/permissions via policies, not string checks scattered in code. Secrets in user-secrets / env vars only.
- Packages via `Directory.Packages.props` (central package management) when the repo has it; Aspire AppHost wires resources (`AddConnectionString` for the shared dev SQL).
- Tests must pass before finishing (`dotnet test`).
