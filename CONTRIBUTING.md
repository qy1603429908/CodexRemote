# Contributing

1. Do not commit `.env`, tokens, certificates, keystores, production endpoints, private IPs, raw task transcripts or personal screenshots.
2. Use synthetic fixtures for Desktop IPC/app-server protocol tests.
3. Run `npm run typecheck`, `npm test` and `npm run build` before opening a change.
4. Large source assets must use Git LFS. APK/AAB binaries belong in Gitea Releases, not source history.
5. Desktop IPC is private and versioned; document the tested Desktop/CLI version when changing protocol handling.
