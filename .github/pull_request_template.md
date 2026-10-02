## Summary

- 

## Architecture

- [ ] `screen_batch` remains generic.
- [ ] Source-specific deterministic logic is in an adapter, not a prompt.
- [ ] Semantic policy is in a preset.
- [ ] Review accounting remains fail-closed.

## Checks

- [ ] `npm test`
- [ ] `npm run typecheck:offline`
- [ ] `npm run pack:dry`
- [ ] Live Pi smoke test when applicable
