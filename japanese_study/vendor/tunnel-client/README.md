# tunnel-client runtime

The executable is intentionally ignored by Git. Install or refresh it from the
official `openai/tunnel-client` GitHub release with:

```powershell
npm run tunnel:install
```

The installer resolves the requested official release, downloads the matching
Windows architecture archive and `SHA256SUMS.txt`, verifies SHA-256, and only
then installs `tunnel-client.exe` here.

Validated locally on 2026-07-19 with `v0.0.10`.
