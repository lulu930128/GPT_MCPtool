# ChatGPT Developer Mode Setup

## Current local contract

- Hub: `http://127.0.0.1:18791`
- MCP: `http://127.0.0.1:18790/mcp`
- Tunnel admin UI: `http://127.0.0.1:18792/ui`
- Tunnel profile: `.tunnel-client\japanese-study.yaml`
- Runtime key storage: `.secrets\control-plane-api-key.dpapi`

The MCP and Hub stay on loopback. `tunnel-client` opens the outbound HTTPS path
to OpenAI and forwards requests locally. The tunnel profile contains only an
environment-variable reference, never the runtime key.

## Secure local setup

1. Create a dedicated tunnel runtime key with `Tunnels Read + Use` in the same
   Platform organization as the tunnel.
2. Do not paste the key into chat or a command. Run `npm run tunnel:key:save` and
   paste it into the masked local dialog.
3. Verify `npm run tunnel:key:status`; a good result has `exists`, `decryptable`,
   and `usable` set to `true`.
4. Run `npm run tunnel:doctor`.
5. Double-click `scripts\Start-Tray.cmd`; wait until Hub, MCP, and Tunnel all
   report Ready.
6. Confirm `npm run tunnel:health` or open the local tunnel admin UI.
7. Confirm `http://127.0.0.1:18790/health` reports
   `contractVersion=learning-content-v7.0`, `toolCount=33`, and a
   16-character `buildId`.
8. Only after the chain is stable, run `npm run startup:install`.

## Create the private ChatGPT app

1. Enable Developer mode in ChatGPT under Settings → Security and login.
2. Open Settings → Plugins and create a developer-mode app.
3. Choose `Tunnel` as the connection type and select the dedicated Japanese
   Study tunnel.
4. Suggested name: `Japanese Study Hub`.
5. Suggested description: `Practice and manage my Japanese vocabulary, study plans, mastery labels, and answer history.`
6. Verify discovery shows exactly 33 tools.
7. Test one read call first, then use `study_preview_practice_record` with a
   small completed session. Preview is read-only; save only when the user
   explicitly asks to record the completed practice.

If local `npm run smoke:live` reports 33 tools but ChatGPT still shows an
older count, rebuild and use `scripts\\Restart-Tray.cmd`, then refresh or
reconnect the ChatGPT connector. Do not rewrite the Hub resolver to work around
a stale connector schema.

If the tunnel is not listed, verify that it is associated with the target
ChatGPT workspace and that the current user has `Tunnels Read + Use`. Developer
mode permission and Platform tunnel permission are separate.

## Safety boundary

- There is no file browser, arbitrary SQL, shell, delete, reset, bulk import,
  general batch resolver, evidence rebuild, catalog admin, Anki write, or
  legacy migration tool.
- Target-resolution preview is read-only. Search returns candidates only.
  `study_apply_practice_target_overrides` requires explicit user confirmation,
  exact item ids, an unchanged preview fingerprint, and a retry-stable
  operation id.
- Tunnel transport is not a replacement for multi-user authorization. Before a
  public or multi-user deployment, add OAuth 2.1 and per-user Hub isolation.
- The legacy Kuro tracker remains unchanged until migration is separately
  validated.

Official references:

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- https://developers.openai.com/apps-sdk/build/auth
