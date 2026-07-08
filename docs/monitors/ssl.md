---
title: SSL Certificate Monitoring
description: Get expiry warnings at 30, 14, 7, and 1 days before a TLS certificate lapses, plus fingerprint-change detection.
---

# SSL Certificate Monitoring

An expired TLS certificate takes a site down for every visitor at once, usually with a scary browser warning. SSL monitoring watches the certificate served on your domain and warns you well before it lapses — and flags unexpected certificate changes that can signal a misconfiguration or compromise.

## How it works

On each run the checker opens a TLS connection to your host, inspects the presented certificate chain, and records:

- **Expiry date** (`notAfter`) and days remaining.
- **Issuer** and subject / SAN coverage for your hostname.
- **SHA-256 fingerprint** of the leaf certificate.
- **Chain validity** — is the chain complete and trusted?

Expiry is evaluated against a tiered schedule and the fingerprint is compared to the last-seen value. Checks run daily by default (you can run them more often).

## What triggers an alert

- **Expiry warnings** fire at **30, 14, 7, and 1 days** before `notAfter`, escalating as the deadline approaches.
- The certificate is **already expired** or **not yet valid**.
- The **fingerprint changes** unexpectedly — useful for spotting a rotation you didn't schedule, or a man-in-the-middle edge.
- The **chain is broken/untrusted**, or the hostname isn't covered by the certificate's SANs.

Renewing the certificate clears the warnings automatically on the next run.

## Setting it up

1. **Add monitor** and choose **SSL Certificate**.
2. Enter the hostname (e.g. `example.com`) and port (defaults to `443`).
3. Confirm the **warning tiers** (30/14/7/1 days) or adjust them.
4. Enable **fingerprint-change detection** if you want rotation alerts (config `alertOnFingerprintChange`; off by default, since routine renewals also change the fingerprint).
5. Attach **notifications**.

> After an automated renewal (e.g. Let's Encrypt), enable fingerprint alerts only if your rotation cadence is predictable — otherwise expected renewals will notify.

## Related

- [Domains](/monitors/domains) · [DNS](/monitors/dns) · [Uptime](/monitors/uptime)
- [Notifications](/operate/notifications)
- Marketing: [SSL monitoring feature](https://uptime-status.org/features/ssl-monitoring)
