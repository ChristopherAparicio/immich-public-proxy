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
