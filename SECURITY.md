# Security Policy

## Supported Versions

Older versions of Pingvin Share do not receive security updates. To ensure your system remains secure, we strongly recommend updating Pingvin Share regularly. You can automate these updates using tools like [Watchtower](https://github.com/containrrr/watchtower).

## Reporting a Vulnerability

Thank you for taking the time to report a vulnerability. Please DO NOT create an issue on GitHub because the vulnerability could get exploited. Instead please write an email to [Simon Thémiot](mailto:simon.themiot@informatiquenevers.fr).

## Reviewed Loopback Transport

PrivCloud Companion deliberately exposes an HTTP endpoint only on the literal
loopback addresses `127.0.0.1` or `::1`. It refuses non-loopback binds and
peers, validates the exact web `Origin`, and requires bearer authentication for
operational endpoints. Traffic therefore does not cross a physical or routed
network interface.

Generic static-analysis rules may report this design as CWE-319 solely because
it uses Node's HTTP server. Replacing it with an ad-hoc self-signed certificate
would not authenticate Companion to browsers unless users installed an
additional local trust root. This finding should be reviewed as not vulnerable
while all loopback, Origin and authentication controls remain in place.
