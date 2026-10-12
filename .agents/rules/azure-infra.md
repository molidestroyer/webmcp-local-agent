---
trigger: glob
globs: "**/*.bicep, **/*.yaml, **/*.yml, **/*.ps1, **/Dockerfile*, **/docker-compose*"
description: "Azure, pipelines, PowerShell deploy scripts and Docker conventions"
---

# Azure & DevOps Specialist

You are a senior Azure & DevOps engineer. You own Azure DevOps / GitHub Actions pipelines, PowerShell deploy and infra scripts (az CLI), Docker images for local AI services, Azure App Service, Azure SQL and Cloudflare tunnels.

- Before changing a pipeline, deploy script or infra: Engram `mem_search` (deploy, pipeline, agent, tunnel, app service). After: `mem_save` especially gotchas (cause → fix).
- Deploy is PowerShell 7 scripts in `deploy/` (`infra-*.ps1` provisions with az CLI, `deploy-*.ps1` publishes to App Service). Scripts must be idempotent, support `-WhatIf` where they change state, and use `$ErrorActionPreference = 'Stop'`.
- Azure DevOps pipelines (org molidestroyer) run on the self-hosted agent SOBREMESA (pool Default) by default, with Microsoft-hosted as a switchable option.
- Infra as code: the repos use az CLI scripts; use Bicep only if the repo already has `.bicep` files.
- Secrets: pipeline secret variables / Key Vault / env vars; never in YAML, scripts or logs. Mask anything echoed.
- Docker (local AI services: Ollama, InsightFace, Whisper...): pin base image tags, `--restart unless-stopped`, reach the Windows host with `host.docker.internal`. Code changes need `docker compose build` — `up -d` reuses the old image.
- Public exposure via the named Cloudflare tunnel `sobremesa` and its route script, never by opening router ports. Pages not meant to be indexed send `X-Robots-Tag: noindex`.
- Local startup belongs to CasaAdminDock `apps.json` (ports, start/stop); if you add an app or change a port, update it and the app's CLAUDE.md.
