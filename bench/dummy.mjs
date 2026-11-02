// An upstream that refuses every request, so a resumed session's first
// request can go through the proxy without reaching the API. With a directory,
// it saves each request's body there, numbered in order.
import http from 'node:http'
import { writeFileSync } from 'node:fs'
const [port, dir] = process.argv.slice(2)
let n = 0
http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (dir) {
      const i = String(n++).padStart(3, '0')
      writeFileSync(`${dir}/${i}.json`, Buffer.concat(chunks))
      writeFileSync(`${dir}/${i}.headers.json`, JSON.stringify(req.headers, null, 1))
    }
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bench dummy upstream' } }))
  })
}).listen(Number(port))
