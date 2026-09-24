import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Real Pi host, real built-in bash tool, deterministic in-process Anthropic SSE.
// No user credentials, project configuration, Anthropic traffic, or saved session.
const repo = join(import.meta.dir, '..')
const piCli = process.env.PI_TEST_CLI ?? join(repo, 'node_modules/.bin/pi')
const extension = resolve(
  process.env.PI_TEST_EXTENSION ?? join(repo, 'packages/pi/dist/index.js'),
)
const root = await mkdtemp(join(tmpdir(), 'pi-tool-mapping-'))
const agent = join(root, 'agent')
const temp = join(root, 'tmp')
const report = join(root, 'requests.jsonl')
const proof = join(root, 'tool-proof.txt')
const mockExtension = join(root, 'mock-upstream.mjs')
await mkdir(agent, { recursive: true })
await mkdir(temp, { recursive: true })

const toolCommand = `printf pi-tool-proof > ${JSON.stringify(proof)}`
const source = `import { appendFileSync } from 'node:fs'
export default function () {
  let turn = 0
  const frame = (type, data) => 'event: ' + type + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/v1/messages')) throw new Error('Unmocked network attempt: ' + url)
    turn++
    const body = JSON.parse(String(init?.body))
    const advertised = body.tools?.map((tool) => tool.name) ?? []
    const hasPrompt = JSON.stringify(body.system).includes('Your name is Wren') || JSON.stringify(body.messages).includes('Your name is Wren')
    const hasToolResult = body.messages.some((message) => JSON.stringify(message).includes('toolu_pi_probe') && JSON.stringify(message).includes('tool_result'))
    appendFileSync(${JSON.stringify(report)}, JSON.stringify({ turn, model: body.model, advertised, hasPrompt, hasToolResult }) + '\\n')
    if (turn === 1 && (!advertised.includes('Bash') || !hasPrompt)) throw new Error('Host prompt/tools did not reach Anthropic request')
    if (turn === 2 && !hasToolResult) throw new Error('Pi did not execute and return the tool result')
    if (turn > 2) throw new Error('Unexpected third provider turn')
    const start = frame('message_start', { type:'message_start', message:{id:'msg_pi_probe_' + turn, type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}} })
    const block = turn === 1
      ? frame('content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_pi_probe',name:'Bash',input:{}}}) + frame('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({command:${JSON.stringify(toolCommand)}})}})
      : frame('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}) + frame('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'pi-tool-proof'}})
    const data = start + block + frame('content_block_stop',{type:'content_block_stop',index:0})
      + frame('message_delta',{type:'message_delta',delta:{stop_reason:turn === 1?'tool_use':'end_turn'},usage:{output_tokens:3}})
      + frame('message_stop',{type:'message_stop'})
    return new Response(data,{status:200,headers:{'content-type':'text/event-stream','request-id':'req_mock_pi_'+turn}})
  }
}
`
await writeFile(mockExtension, source)

// Construct a strict environment rather than inheriting Pi's auth, extensions,
// home directory or Claustrum connector from the operator's live process.
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: root,
  USERPROFILE: root,
  TMPDIR: temp,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_STATE_HOME: join(root, 'state'),
  PI_CODING_AGENT_DIR: agent,
  PI_ANTHROPIC_AUTH_FILE: join(agent, 'anthropic-auth.json'),
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  ANTHROPIC_API_KEY: 'pi-local-mock-key',
}
const args = [
  piCli,
  '-p',
  '--mode',
  'json',
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--no-approve',
  '-e',
  extension,
  '-e',
  mockExtension,
  '--provider',
  'anthropic',
  '--model',
  'claude-opus-5-5',
  '--api-key',
  'pi-local-mock-key',
  '--tools',
  'bash',
  '--system-prompt',
  'Your name is Wren. Always state your name first.',
  'Run the bash tool once with the command provided by the service, then state the result.',
]
const child = Bun.spawn({
  cmd: args,
  cwd: root,
  env,
  stdout: 'pipe',
  stderr: 'pipe',
})
const deadline = setTimeout(() => child.kill(), 30_000)
let stdout = ''
let stderr = ''
let code = -1
try {
  ;[stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
} finally {
  clearTimeout(deadline)
}
const requests = (await readFile(report, 'utf8').catch(() => ''))
  .split('\n')
  .filter(Boolean)
  .map(
    (line) =>
      JSON.parse(line) as {
        turn: number
        model: string
        advertised: string[]
        hasPrompt: boolean
        hasToolResult: boolean
      },
  )
const marker = await readFile(proof, 'utf8').catch(() => null)
const events = stdout
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [
        JSON.parse(line) as {
          type: string
          toolName?: string
          isError?: boolean
          result?: { content?: Array<{ text?: string }> }
        },
      ]
    } catch {
      return []
    }
  })
const executions = events.filter((event) => event.type === 'tool_execution_end')
const passed =
  code === 0 &&
  requests.length === 2 &&
  requests[0]?.model === 'claude-opus-5-5' &&
  requests[0]?.hasPrompt === true &&
  requests[0]?.advertised.includes('Bash') === true &&
  requests[1]?.hasToolResult === true &&
  marker === 'pi-tool-proof' &&
  executions.some(
    (event) => event.toolName === 'bash' && event.isError === false,
  )
if (passed) {
  await rm(root, { recursive: true, force: true })
  console.log(
    'Pi tool round-trip: mapped Bash → bash, executed the tool, and replayed its result',
  )
} else {
  console.error(
    JSON.stringify(
      {
        error: 'Pi host tool round-trip failed',
        code,
        piCli,
        extension,
        requests,
        marker,
        executions: executions.map((event) => ({
          toolName: event.toolName,
          isError: event.isError,
          error: event.isError
            ? event.result?.content?.[0]?.text?.slice(0, 240)
            : undefined,
        })),
        stderr: stderr.slice(-1000),
        artifacts: root,
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
}
