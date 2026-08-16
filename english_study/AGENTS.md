# English Study MCP adapter

This component is a bounded TypeScript adapter for the authoritative Hub at
`C:\project\english-study-hub`.

## Boundaries

- Never open the Hub SQLite database or implement domain logic in this adapter.
- Expose only versioned, bounded Hub operations. No arbitrary file, SQL, shell,
  delete/reset, unrestricted import, audio, or migration/admin tools.
- Important writes require explicit user intent and stable retry ids. Item and
  practice writes must follow preview then confirmed apply.
- Preserve Hub error codes, partial/void states, and strict structured output.
- Keep tokens, local profiles, runtime logs, PIDs, and generated artifacts out of Git.

## Validation

- `npm test`
- `npm run smoke:http`
- `npm run smoke:live` only against a disposable Hub database.
