---
title: Lighthouse Monitoring
description: Run scheduled Google Lighthouse audits and get alerted when your performance, accessibility, SEO, or best-practices scores regress.
---

# Lighthouse Monitoring

Lighthouse monitoring runs Google's Lighthouse audit against your page on a schedule and tracks the scores over time. It's how you catch a front-end regression — a heavy new hero image, a render-blocking script, a broken meta tag — before it quietly erodes your Core Web Vitals and your search ranking.

## How it works

On each run UptimeStatus loads your page in a headless browser and runs a full **Lighthouse** audit, capturing the four category scores (0–100):

- **Performance** — including Core Web Vitals: LCP, CLS, TBT.
- **Accessibility**
- **Best Practices**
- **SEO**

Scores and the underlying metrics are stored so you can chart trends and compare a run against the previous baseline. Because a full audit is heavier than a simple fetch, Lighthouse runs on a longer cadence (typically daily, configurable).

## What triggers an alert

- Any category score drops **below a minimum threshold** you set (e.g. Performance `< 80`).
- A **regression versus the last run / baseline** larger than your tolerance (e.g. Performance fell 15+ points).
- A specific **Core Web Vital** crosses its threshold (e.g. LCP `> 2.5s`).

Each alert links to the full report so you can see exactly which audits regressed.

## Setting it up

1. **Add monitor** and choose **Lighthouse**.
2. Enter the page URL to audit.
3. Choose the **device profile** (mobile / desktop) and cadence.
4. Set **minimum scores** and **regression tolerances** per category.
5. Attach **notifications**.

## Related

- [Performance](/monitors/performance) · [Broken Links](/monitors/broken-links) · [Uptime](/monitors/uptime)
- [Notifications](/operate/notifications)
- Marketing: [Lighthouse monitoring feature](https://uptime-status.org/features/lighthouse-monitoring)
