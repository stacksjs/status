---
title: Domain Monitoring
description: WHOIS-based warnings before your domain registration expires, so a lapsed renewal never takes you offline.
---

# Domain Monitoring

Your TLS certificate can be perfect and your servers healthy — and you'll still go dark if the *domain registration* lapses. Domain monitoring watches the registration itself via WHOIS and warns you long before the expiry date, so a missed renewal invoice never becomes an outage (or a lost domain).

## How it works

On each run the checker performs a **WHOIS** (and RDAP where available) lookup for your domain and records:

- **Registration expiry date** and days remaining.
- **Registrar** and **domain status** codes (e.g. `clientTransferProhibited`, `redemptionPeriod`).
- **Nameservers** currently on record.

Because registration data changes slowly, domain checks run on a daily cadence.

## What triggers an alert

- **Expiry warnings** fire at tiered thresholds — commonly **60, 30, 14, 7, and 1 days** before expiry — escalating as the date nears.
- The domain has **already expired** or entered a **redemption / pending-delete** status.
- The **registrar or status codes change** unexpectedly (for example, a `Hold` status that would suspend resolution).

Renewing with your registrar clears the warnings on the next daily lookup.

## Setting it up

1. **Add monitor** and choose **Domain**.
2. Enter the registrable domain (e.g. `example.com` — not a subdomain).
3. Confirm the **warning thresholds** or adjust them to match your renewal lead time.
4. Attach **notifications** — route these to whoever owns billing/renewals.

> WHOIS coverage varies by TLD. A few registries rate-limit or redact expiry data; where the date is unavailable we surface status changes instead and note the limitation on the monitor.

## Related

- [SSL](/monitors/ssl) · [DNS](/monitors/dns) · [Uptime](/monitors/uptime)
- [Notifications](/operate/notifications)
- Marketing: [Domain monitoring feature](https://uptime-status.org/features/domain-monitoring)
