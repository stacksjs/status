import { connect } from 'node:net'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'
import PortScanResult from '../Models/PortScanResult'

const WELL_KNOWN_RANGE_END = 1024
const FULL_RANGE_END = 65535
const CONCURRENCY = 100
const CONNECT_TIMEOUT_MS = 2000

function checkPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: CONNECT_TIMEOUT_MS })
    const finish = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.on('connect', () => finish(true))
    socket.on('timeout', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

async function scanPorts(host: string, ports: number[]): Promise<number[]> {
  const open: number[] = []
  for (let i = 0; i < ports.length; i += CONCURRENCY) {
    const batch = ports.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(port => checkPort(host, port)))
    results.forEach((isOpen, idx) => { if (isOpen) open.push(batch[idx]!) })
  }
  return open
}

/**
 * Scans a configurable port range and alerts when an expected port goes
 * down or an unexpected port appears — surfacing both "the database port I
 * meant to firewall is open to the world" and "the API I depend on somehow
 * stopped listening" cases.
 *
 * Config (monitor.config JSON): { expectedPorts?: number[], fullScan?: bool }.
 * Default range is well-known ports (1-1024) plus any explicitly expected
 * ports; scanning the full 65535 is opt-in (fullScan: true) given the cost
 * — at CONCURRENCY=100 and a 2s timeout, a full scan is still a couple of
 * minutes even when every port is closed (the worst case, since a closed
 * port has to wait out the timeout).
 */
export default new Job({
  name: 'RunPortScan',
  description: 'Scan a monitor\'s host for open ports',
  queue: 'crawls', // shares the "expensive, infrequent" queue with RunCrawl
  tries: 1,
  timeout: 300,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunPortScan: monitor ${payload.monitorId} not found`)
      return
    }

    let host = monitor.url
    try {
      host = new URL(monitor.url).hostname
    }
    catch {
      // bare hostname, no scheme
    }

    let config: { expectedPorts?: number[], fullScan?: boolean } = {}
    try {
      config = monitor.config ? JSON.parse(monitor.config) : {}
    }
    catch {
      // malformed config JSON — fall back to defaults
    }

    const expectedPorts = Array.isArray(config.expectedPorts) ? config.expectedPorts : []
    const rangeEnd = config.fullScan ? FULL_RANGE_END : WELL_KNOWN_RANGE_END
    const rangePorts = Array.from({ length: rangeEnd }, (_, i) => i + 1)
    const portsToScan = [...new Set([...rangePorts, ...expectedPorts])]

    const checkedAt = new Date().toISOString()
    const openPorts = await scanPorts(host, portsToScan)

    await PortScanResult.create({
      monitor_id: monitor.id,
      open_ports: JSON.stringify(openPorts),
      expected_ports: JSON.stringify(expectedPorts),
      checked_at: checkedAt,
    })

    const missingExpected = expectedPorts.filter(p => !openPorts.includes(p))
    const unexpectedOpen = openPorts.filter(p => expectedPorts.length > 0 && !expectedPorts.includes(p))

    if (missingExpected.length > 0) {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `Expected port(s) ${missingExpected.join(', ')} are no longer open on ${host}`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'port_scan', missingExpected }]),
      })
      log.warn(`[job] RunPortScan: ${monitor.name} — expected port(s) down: ${missingExpected.join(', ')}`)
    }

    if (unexpectedOpen.length > 0) {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `Unexpected port(s) ${unexpectedOpen.join(', ')} are open on ${host}`,
        status: 'monitoring',
        impacted_checks: JSON.stringify([{ type: 'port_scan', unexpectedOpen }]),
      })
      log.warn(`[job] RunPortScan: ${monitor.name} — unexpected port(s) open: ${unexpectedOpen.join(', ')}`)
    }
  },
})
