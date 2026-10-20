# Maintainer documentation

One file per area. A future agent or a new human should be able to change any part of
Forerunner from these files alone. `scripts/docs-check.mjs` maps modules to the files here and
fails a PR that changes a module without touching its doc.

| File | Covers |
| --- | --- |
| architecture.md | components, data flow, diagram source |
| data-model.md | generated from the schema on every build (`pnpm docs:schema`) |
| runtime.md | hooks, budget, depth, autonomy and permission enforcement |
| commands.md | command registry, intent parsing, change cards, undo |
| billing.md | billing sources, routing, what to change when provider rules change |
| memory.md | lessons, retrieval, consolidation, promotion |
| critic.md | tiers, verdicts, findings, calibration |
| voice.md, adding-a-voice-provider.md | STT/TTS/VAD loop and providers |
| capabilities.md, adding-a-connector.md | browser, email, desktop control, MCP connectors |
| adding-a-specialist.md, adding-a-provider.md | registry entries and model providers |
| state-service.md | shared state service, realtime, device auth |
| cloud-runner.md | headless runner image and email command watcher |
| apps.md | desktop, Android and approvals web app |
| platform-notes.md | Windows and Linux differences and known issues |
| release.md | signing, staged rollout, rollback |
| migrations.md | schema and memory-format migrations |
| security.md | threat model and the injection test suite |
| testing.md | test environment, stand-ins, the nine scenarios |
| troubleshooting.md | common failures and fixes |
| sandbox.md | Docker/Podman container adapter, process stand-in, worktree mounts, egress |
| extensions.md | extensions registry, MCP connector review and approval, live revocation |
| updates.md | release feeds, signed manifests, staged install, health check, rollback |
| model-watch.md | weekly model watch and estimate learning (written with the model watch) |
| notifications.md | channels, quiet hours, digest (written with the notifications module) |
| data.md | files, folders, datasets, imports (written with the data module) |
| email.md, browser.md, desktop-control.md, cloudflare.md | one file per capability |
