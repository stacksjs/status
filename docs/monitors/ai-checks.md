---
title: AI Checks
description: Describe an assertion in plain language and let an AI check verify it against your page or API response on every run.
---

# AI Checks

AI checks let you assert things that are hard to express as a status code or a keyword. You write what "correct" looks like in plain language, and on each run an AI model evaluates your page or API response against that description — passing or failing with a short explanation.

## How it works

On each run the checker fetches your target (a rendered page or an API response), then asks an AI model to evaluate your natural-language assertion against the content. It returns a **pass/fail** verdict plus a **rationale** so you can see *why* it decided that.

This shines for checks that resist rigid rules:

- "The pricing page shows three plans and none of them say **Coming soon**."
- "The homepage headline is in English and mentions our product name."
- "The checkout confirmation includes an order number and a total in USD."
- "The API response returns a list of at least five products, each with a non-empty name and price."

Because a model call is heavier than a fetch, AI checks run on a moderate cadence (configurable). Keep assertions specific and observable so verdicts stay consistent.

## What triggers an alert

- The AI evaluates the assertion as **false** for the current content.
- The target is **unreachable** or returns an error before evaluation.
- Optionally, **low-confidence** verdicts can be surfaced as warnings for you to review.

The rationale is attached to the incident so you can confirm the call quickly.

## Setting it up

1. **Add monitor** and choose **AI Check**.
2. Enter the target URL (page or API endpoint).
3. Write your **assertion** in plain language — be specific about what must be true.
4. Set the **check interval**.
5. Attach **notifications**.

> Phrase assertions around things that are visibly true or false on the page. Vague or subjective prompts ("does it look good?") produce inconsistent verdicts — prefer concrete, checkable statements.

## Related

- [Health Checks](/monitors/health-checks) · [Uptime](/monitors/uptime) · [Broken Links](/monitors/broken-links)
- [Notifications](/operate/notifications)
- Marketing: [AI checks feature](https://uptime-status.org/features/ai-checks)
