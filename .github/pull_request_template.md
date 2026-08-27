## Summary

Describe the user-visible change and why it belongs in this fork rather than upstream.

## Security and privacy

- [ ] No real share key, password, API key, private address or photo is included.
- [ ] Invalid and unauthorized requests remain fail-closed.
- [ ] New input is bounded and validated.
- [ ] ZIP disk, memory, concurrency and cleanup behaviour was considered.

## Validation

- [ ] `npm ci --include=dev --ignore-scripts`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] Production Docker image builds successfully.
- [ ] Relevant 200/206/413/429/507 behaviour was tested.

## Upstream impact

- [ ] The fork delta is documented in `FORK.md` when necessary.
- [ ] I considered proposing the generic portion upstream.
