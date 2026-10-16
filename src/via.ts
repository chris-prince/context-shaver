// Where a request goes. A session behind another proxy or gateway (bin/claude-via-shaver)
// has a base URL of /via/<upstream>, the upstream's own base URL
// percent-encoded as one path segment: its requests go there, with the prefix
// stripped, so one proxy serves sessions behind different upstreams. Any other
// request goes to the proxy's --upstream.
//
// A wrapper also names the harness it launches (harness.ts) with /harness/<name>
// before any /via/, which is stripped too.
//
// Anything that reaches 127.0.0.1 can name an upstream, so a request is only
// served if its Host is this machine's (localHost): a web page that gets here by
// DNS rebinding sends its own domain, and could otherwise read what the proxy
// fetches for it.

const VIA = /^\/via\/([^/?#]*)(.*)$/
const HARNESS = /^\/harness\/([^/?#]*)(.*)$/

export function route(full: string, fallback: string): { upstream: string; url: string; harness?: string } | { error: string } {
  const h = HARNESS.exec(full)
  const url = h ? (h[2].startsWith('/') ? h[2] : '/' + h[2]) : full
  const harness = h ? { harness: h[1] } : {}
  const m = VIA.exec(url)
  if (!m) return { upstream: fallback, url, ...harness }
  let u: URL
  try {
    u = new URL(decodeURIComponent(m[1]))
  } catch {
    return { error: `not an upstream URL: /via/${m[1]}` }
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash)
    return { error: `not an http(s) base URL: ${u.href}` }
  const rest = m[2].startsWith('/') || !m[2] ? m[2] || '/' : '/' + m[2]
  return { upstream: u.origin + u.pathname.replace(/\/+$/, ''), url: rest, ...harness }
}

// True if a Host header names this machine, with any port.
export function localHost(host: string | undefined): boolean {
  if (!host) return false
  return /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(host)
}
