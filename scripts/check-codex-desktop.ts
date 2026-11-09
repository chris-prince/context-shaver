// Live, opt-in smoke test of the app-server transport used by Codex desktop.
// Uses the existing Codex sign-in and makes one billable model request.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const child = spawn(`${repo}bin/codex-via-shaver`, ['app-server'], {
  cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
})
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
let id = 0
let text = ''
let completion: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined
const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
const lines = createInterface({ input: child.stdout })
// Diagnostics stay on stderr; no request bodies or credentials are logged here.
child.stderr.on('data', data => process.stderr.write(data))
function fail(error: Error) {
  for (const p of pending.values()) p.reject(error)
  pending.clear()
  completion?.reject(error)
}
child.on('error', fail)
child.on('exit', code => fail(new Error(`app-server exited (${code})`)))
lines.on('line', line => {
  let message: any
  try { message = JSON.parse(line) } catch { return }
  if (message.id !== undefined && pending.has(message.id)) {
    const p = pending.get(message.id)!
    pending.delete(message.id)
    if (message.error) p.reject(new Error(JSON.stringify(message.error)))
    else p.resolve(message.result)
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: 'This connection test does not execute tools or approvals' } })
  } else if (message.method === 'item/completed' && message.params.item.type === 'agentMessage') {
    text = message.params.item.text
  } else if (message.method === 'turn/completed' && completion) {
    const c = completion
    completion = undefined
    if (message.params.turn.status === 'completed') c.resolve(text)
    else c.reject(new Error(JSON.stringify(message.params.turn.error)))
  }
})
function call(method: string, params: object): Promise<any> {
  return new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    send({ id, method, params })
  })
}
async function turn(threadId: string, prompt: string): Promise<string> {
  text = ''
  const done = new Promise<string>((resolve, reject) => { completion = { resolve, reject } })
  // Attach rejection handling before the request can fail or the child can exit.
  const started = call('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] })
  const [, answer] = await Promise.all([started, done])
  return answer
}
let timer: ReturnType<typeof setTimeout>
try {
  await Promise.race([
    (async () => {
      await call('initialize', { clientInfo: { name: 'context_shaver_desktop_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      send({ method: 'initialized' })
      const result = await call('thread/start', {
        cwd: repo, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
        baseInstructions: 'This is a connection test. Follow the requested exact output and do not call tools.',
      })
      const answer = await turn(result.thread.id, 'Reply with exactly: context-shaver-desktop-route-ok')
      if (answer.trim() !== 'context-shaver-desktop-route-ok') throw new Error('Unexpected upstream reply')
      const status = await turn(result.thread.id, 'shaver info')
      if (!status.includes('Shaver Summary') || !status.includes('1 request')) throw new Error('Proxy did not record the model request')
      console.log(`App-server request and context-shaver status passed (model: ${result.model}).`)
      console.log(status)
    })(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Probe timed out after 90 seconds')), 90_000) }),
  ])
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  clearTimeout(timer!)
  lines.close()
  child.kill()
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
}
