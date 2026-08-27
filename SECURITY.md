# Security policy

## Supported versions

Only the latest `immich-share` fork release receives security fixes. Images are
published by immutable digest; older releases remain available for rollback but
should not be treated as supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private
vulnerability reporting in the repository Security tab. Include the affected
version or image digest, reproduction steps, impact and any suggested mitigation.

Do not include real share keys, passwords, Immich API keys, private addresses or
photos. Use synthetic assets and a temporary share when a reproduction requires
runtime data.

We aim to acknowledge a complete report within three business days. Timelines
for validation, remediation and coordinated disclosure depend on severity and
whether the issue is inherited from upstream.

## Deployment boundary

This proxy is only one layer of a secure deployment. Operators must still use
TLS, isolate Immich from the public network, restrict the proxy's upstream
network path, configure resource limits and keep share passwords and expiries
appropriate for their threat model. The companion `immich-share` repository
documents the hardened NAS, tunnel and VPS architecture.

## Browser request integrity

Every state-changing browser endpoint requires both a host-only CSRF cookie and
the same value in the `X-IPP-CSRF-Token` header. The token contains a random
nonce authenticated with a process-local HMAC secret, and comparison is
constant-time. This prevents a sibling subdomain from manufacturing a valid
double-submit token. Fetch Metadata must also identify the request as
same-origin (or a direct browser navigation context).

The CSRF token is deliberately kept out of cached gallery HTML. Its cookie is
`SameSite=Strict`, becomes `Secure` in production, and is replaced after eight
hours or whenever its HMAC is invalid. Regression tests cover matching,
missing, forged and cross-site token cases.
