---
title: Broken-Link Monitoring
description: Crawl your site on a schedule and report broken links, dead resources, and mixed-content warnings.
---

# Broken-Link Monitoring

Broken links and mixed-content warnings erode trust and hurt SEO, and they creep in silently as content and dependencies change. Broken-link monitoring crawls your site on a schedule and reports every dead link and insecure resource it finds, with the exact page each one lives on.

## How it works

On each run the crawler starts from a URL you choose, follows internal links up to a configurable depth, and checks every link and resource it encounters. It records:

- **Broken links** — any link returning `4xx`/`5xx` or failing to connect, with the source page and anchor text.
- **Mixed content** — `http://` resources (scripts, images, styles) loaded on an `https://` page.
- **Redirect chains** — links that resolve only after multiple hops.

You control **crawl depth**, whether **external** links are checked, and paths to **exclude**. Because a crawl is heavier than a single check, it runs on a longer cadence (typically daily, configurable).

## What triggers an alert

- One or more **broken internal links** are found.
- **Mixed-content** resources are detected on secure pages.
- The count of broken links **rises versus the previous crawl** (so you're alerted on new breakage, not the same known backlog every day).

Each report lists the offending URL, the page it was found on, and the status returned.

## Setting it up

1. **Add monitor** and choose **Broken Links**.
2. Enter the **start URL** (usually your homepage).
3. Set the **crawl depth** and choose whether to check **external** links.
4. Add **exclude** patterns for paths you don't want crawled.
5. Set the cadence and attach **notifications**.

> Keep external-link checking off if third-party sites rate-limit your crawl — it can produce noisy, transient failures outside your control.

## Related

- [Lighthouse](/monitors/lighthouse) · [Performance](/monitors/performance) · [Uptime](/monitors/uptime)
- [Notifications](/operate/notifications)
- Marketing: [Broken-link monitoring feature](https://uptime-status.org/features/broken-link-monitoring)
