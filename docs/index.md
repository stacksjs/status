---
title: UptimeStatus Documentation
description: Open-source uptime, SSL, DNS, and status-page monitoring. Self-hosted, or fully managed by us.
layout: home
hero:
  name: UptimeStatus
  text: Know the moment something breaks.
  tagline: Open-source uptime, SSL, DNS, and status-page monitoring — self-hosted, or fully managed by us.
  image: /hero-monitor.svg
  actions:
    - theme: brand
      text: Quick start
      link: /getting-started
    - theme: alt
      text: Open the dashboard
      link: https://uptime-status.org/dashboard
    - theme: alt
      text: View on GitHub
      link: https://github.com/stacksjs/status
---

<section class="dx-section">
  <div class="dx-head">
    <span class="dx-eyebrow">Get started</span>
    <h2 class="dx-title">Monitoring in four steps</h2>
    <p class="dx-lead">New here? Start here — most teams have their first alert routed in a few minutes.</p>
  </div>
  <div class="dx-grid">
    <a class="dx-card dx-step" href="/getting-started">
      <span class="dx-num">1</span>
      <h3>Create your account</h3>
      <p>Sign up free — 5 monitors, no card — or self-host the whole thing from the repo.</p>
      <span class="dx-more">Quick start →</span>
    </a>
    <a class="dx-card dx-step" href="/monitors/">
      <span class="dx-num">2</span>
      <h3>Add your first monitor</h3>
      <p>Point a monitor at a URL, host, or port. Uptime, SSL, DNS and more each become a check.</p>
      <span class="dx-more">Browse monitors →</span>
    </a>
    <a class="dx-card dx-step" href="/operate/notifications">
      <span class="dx-num">3</span>
      <h3>Route your alerts</h3>
      <p>Attach Email, SMS, Slack, Discord, Teams, PagerDuty and more — routed per monitor.</p>
      <span class="dx-more">Notifications →</span>
    </a>
    <a class="dx-card dx-step" href="/operate/status-pages">
      <span class="dx-num">4</span>
      <h3>Publish a status page</h3>
      <p>Give customers a page on your own domain that reflects your monitors in real time.</p>
      <span class="dx-more">Status pages →</span>
    </a>
  </div>
</section>

<section class="dx-section">
  <div class="dx-head">
    <span class="dx-eyebrow">Availability</span>
    <h2 class="dx-title">Is it up?</h2>
  </div>
  <div class="dx-grid">
    <a class="dx-card" href="/monitors/uptime"><h3>Uptime</h3><p>HTTP(S) checks with status code, latency, and keyword assertions — from multiple regions.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/ping"><h3>Ping</h3><p>ICMP reachability for hosts that don't speak HTTP.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/tcp-port"><h3>TCP port</h3><p>Confirm a port accepts connections — databases, SMTP, custom services.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/cron-heartbeats"><h3>Cron &amp; heartbeats</h3><p>Watch scheduled jobs by expecting a ping on a cadence, and alert when one is overdue.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/health-checks"><h3>Health checks</h3><p>Parse a JSON health endpoint and alert on degraded fields.</p><span class="dx-more">Reference →</span></a>
  </div>
</section>

<section class="dx-section">
  <div class="dx-head">
    <span class="dx-eyebrow">Certificates &amp; DNS</span>
    <h2 class="dx-title">Certificates &amp; DNS</h2>
  </div>
  <div class="dx-grid">
    <a class="dx-card" href="/monitors/ssl"><h3>SSL certificates</h3><p>Expiry warnings at 30/14/7/1 days and fingerprint-change detection.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/domains"><h3>Domains</h3><p>WHOIS-based domain-registration expiry warnings.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/dns"><h3>DNS records</h3><p>Snapshot A, AAAA, MX, TXT, NS, CAA and alert on any change.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/dns-blocklist"><h3>DNS blocklists</h3><p>Watch your origin IP against public spam and abuse blocklists.</p><span class="dx-more">Reference →</span></a>
  </div>
</section>

<section class="dx-section">
  <div class="dx-head">
    <span class="dx-eyebrow">Performance &amp; security</span>
    <h2 class="dx-title">Fast and safe</h2>
  </div>
  <div class="dx-grid">
    <a class="dx-card" href="/monitors/performance"><h3>Performance</h3><p>Track response-time trends and catch slow regressions.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/lighthouse"><h3>Lighthouse</h3><p>Scheduled Lighthouse audits with performance-trend alerts.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/broken-links"><h3>Broken links</h3><p>Crawl a site and report broken links and mixed content.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/port-scan"><h3>Port scan</h3><p>Detect newly exposed ports on your servers.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/server-metrics"><h3>Server metrics</h3><p>Push CPU and RAM from your box and chart host telemetry.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/monitors/ai-checks"><h3>AI checks</h3><p>Describe an assertion in plain language; an AI check verifies it.</p><span class="dx-more">Reference →</span></a>
  </div>
</section>

<section class="dx-section">
  <div class="dx-head">
    <span class="dx-eyebrow">Operate</span>
    <h2 class="dx-title">When things go wrong</h2>
  </div>
  <div class="dx-grid">
    <a class="dx-card" href="/operate/incidents"><h3>Incidents</h3><p>Failed checks open a timeline incident automatically — acknowledge and resolve.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/operate/notifications"><h3>Notifications</h3><p>Ten channels, routed per monitor, with issue-vs-down severity.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/operate/status-pages"><h3>Status pages</h3><p>Public or access-controlled pages, custom domains, subscribers.</p><span class="dx-more">Reference →</span></a>
    <a class="dx-card" href="/operate/maintenance"><h3>Maintenance</h3><p>Schedule windows so planned work doesn't page you or dent your uptime.</p><span class="dx-more">Reference →</span></a>
  </div>
</section>

<section class="dx-section">
  <div class="dx-head">
    <span class="dx-eyebrow">Run it yourself</span>
    <h2 class="dx-title">Self-hosting &amp; API</h2>
  </div>
  <div class="dx-grid">
    <a class="dx-card" href="/self-hosting/deploy"><h3>Deploy</h3><p>Clone the MIT-licensed repo and run it on a single box behind a reverse proxy.</p><span class="dx-more">Deploy guide →</span></a>
    <a class="dx-card" href="/self-hosting/configuration"><h3>Configuration</h3><p>Env vars and config files for database, mail, notifications, and SSO.</p><span class="dx-more">Configure →</span></a>
    <a class="dx-card" href="/self-hosting/scaling"><h3>Scaling &amp; regions</h3><p>Add regional check workers with the push-probe consensus model.</p><span class="dx-more">Scale →</span></a>
    <a class="dx-card" href="/reference/cli"><h3>CLI</h3><p>Operate everything from <code>buddy</code> — serve, migrate, queue, deploy.</p><span class="dx-more">CLI reference →</span></a>
    <a class="dx-card" href="/reference/api"><h3>API</h3><p>A JSON API for monitors, incidents, and status — same-origin under /api.</p><span class="dx-more">API reference →</span></a>
  </div>
</section>
