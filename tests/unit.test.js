const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const serverInternals = require('../server.js').__test;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-test-'));
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
}

test('auth import copies valid deepseek-auth.json and chmods it to 0600', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'source-auth.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify({
    token: 'tok_123',
    cookie: 'ds_session_id=abc; other=def',
    hif_dliq: 'dliq',
    hif_leim: 'leim',
    wasmUrl: 'https://example.com/sha3.wasm',
  }));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_123');
  assert.match(imported.cookie, /ds_session_id=abc/);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(dst).mode & 0o777), 0o600);
  }
});

test('auth import accepts browser cookie export plus token env', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([
    { domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' },
    { domain: 'chat.deepseek.com', name: 'smidV2', value: 'smid' },
    { domain: 'example.com', name: 'ignored', value: 'nope' },
  ]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst], { env: { DEEPSEEK_TOKEN: 'tok_env' } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_env');
  assert.equal(imported.cookie, 'ds_session_id=abc; smidV2=smid');
});

test('auth import rejects token passed as CLI arg before prompting or reading files', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([{ domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' }]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst, '--token', 'tok_cli']);
  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /Refusing --token/i);
  assert.equal(fs.existsSync(dst), false);

  const noInput = runNode(['scripts/auth_import.js', '--token', 'tok_cli']);
  assert.equal(noInput.status, 2);
  assert.match(noInput.stderr + noInput.stdout, /Refusing --token/i);

  const badInput = runNode(['scripts/auth_import.js', '--input', path.join(dir, 'missing.json'), '--token', 'tok_cli']);
  assert.equal(badInput.status, 2);
  assert.match(badInput.stderr + badInput.stdout, /Refusing --token/i);
});

test('auth import help ignores comma-list DEEPSEEK_AUTH_PATH as default output', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const res = runNode(['scripts/auth_import.js', '--help'], { env: { DEEPSEEK_AUTH_PATH: `${a},${b}` } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  assert.match(res.stdout, /deepseek-auth\.json/);
});

test('doctor reports auth problems without requiring Chrome or network', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'broken-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ token: '', cookie: '' }));
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /token missing/i);
  assert.match(res.stdout + res.stderr, /cookie missing/i);
});

test('chrome auth prints actionable OS instructions when Chrome is missing', () => {
  const dir = tmpdir();
  const fakeChrome = path.join(dir, 'missing-chrome');
  const res = runNode(['scripts/deepseek_chrome_auth.js'], { env: { CHROME_PATH: fakeChrome } });
  assert.notEqual(res.status, 0);
  const out = res.stdout + res.stderr;
  assert.match(out, /Windows/i);
  assert.match(out, /macOS/i);
  assert.match(out, /Linux/i);
  assert.match(out, /CHROME_PATH/i);
});

test('chrome extension manifest only declares icon files that exist', () => {
  const manifestPath = path.join(ROOT, 'chrome-extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const iconPaths = [];

  function collectIconPaths(value, key = '') {
    if (typeof value === 'string') {
      if (key === 'icons' || key === 'default_icon') iconPaths.push(value);
      return;
    }

    if (!value || typeof value !== 'object') return;

    if ((key === 'icons' || key === 'default_icon') && !Array.isArray(value)) {
      for (const iconPath of Object.values(value)) {
        if (typeof iconPath === 'string') iconPaths.push(iconPath);
      }
      return;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      collectIconPaths(childValue, childKey);
    }
  }

  collectIconPaths(manifest);

  for (const iconPath of iconPaths) {
    assert.equal(
      fs.existsSync(path.join(path.dirname(manifestPath), iconPath)),
      true,
      `Missing extension icon declared in manifest: ${iconPath}`,
    );
  }
});

test('DeepSeek stream parser treats SEARCH fragments as assistant output', () => {
  const rebuilt = serverInternals.rebuildFragmentText([
    { type: 'SEARCH', content: 'The official Reuters website is ' },
    { type: 'SEARCH', content: 'https://www.reuters.com/.' },
  ]);

  assert.equal(rebuilt.responseText, 'The official Reuters website is https://www.reuters.com/.');
  assert.equal(rebuilt.thinkText, '');
});

test('DeepSeek stream parser applies response-level fragment append patches', () => {
  const fragments = [];
  const appendFragments = (value) => {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) fragments.push({ ...fragment });
  };

  const applied = serverInternals.applyResponsePatchOperations([
    { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'The' }] },
    { p: 'has_pending_fragment', o: 'SET', v: false },
  ], appendFragments);

  assert.equal(applied, true);
  assert.deepEqual(fragments, [{ type: 'RESPONSE', content: 'The' }]);
  assert.equal(serverInternals.rebuildFragmentText(fragments).responseText, 'The');
});

test('DeepSeek stream parser does not treat service content chunks as model errors', () => {
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ content: 'Official Reuters website URL' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ finish_reason: 'stop' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ type: 'error', content: 'backend error' }), true);
});

test('sweepIdleSessions evicts only idle entries', () => {
  serverInternals.sessions.set('stale-x', { lastActivityAt: 1 });
  serverInternals.sessions.set('fresh-x', { lastActivityAt: Date.now() });
  serverInternals.sweepIdleSessions(60 * 1000);
  assert.equal(serverInternals.sessions.has('stale-x'), false);
  assert.equal(serverInternals.sessions.has('fresh-x'), true);
  serverInternals.sessions.delete('fresh-x');
});

test('proxy API key authentication is optional and uses exact bearer tokens', () => {
  assert.equal(serverInternals.isProxyAuthorized(undefined, ''), true);
  assert.equal(serverInternals.isProxyAuthorized('Bearer secret', 'secret'), true);
  assert.equal(serverInternals.isProxyAuthorized('Bearer wrong', 'secret'), false);
  assert.equal(serverInternals.isProxyAuthorized('Basic secret', 'secret'), false);
  assert.equal(serverInternals.isProxyAuthorized('Bearer secret ', 'secret'), false);
});

test('loopback host detection covers supported local bind addresses', () => {
  assert.equal(serverInternals.isLoopbackHost('127.0.0.1'), true);
  assert.equal(serverInternals.isLoopbackHost('::1'), true);
  assert.equal(serverInternals.isLoopbackHost('[::1]'), true);
  assert.equal(serverInternals.isLoopbackHost('::ffff:127.0.0.1'), true);
  assert.equal(serverInternals.isLoopbackHost('localhost'), true);
  assert.equal(serverInternals.isLoopbackHost('0.0.0.0'), false);
});

test('browser origin guard allows local UIs and exact configured origins only', () => {
  const allowed = new Set(['https://ui.example.com', 'chrome-extension://trusted-id']);
  assert.equal(serverInternals.isBrowserOriginAllowed(undefined, allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://localhost:3000', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://127.0.0.1:8080', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://[::1]:3000', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('https://ui.example.com/path', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('chrome-extension://trusted-id', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('https://evil.example', allowed), false);
  assert.equal(serverInternals.isBrowserOriginAllowed('chrome-extension://other-id', allowed), false);
  assert.equal(serverInternals.isBrowserOriginAllowed('null', allowed), false);
});

test('parseToolCall converts canonical DeepSeek DSML into an OpenAI tool call', () => {
  const dsml = [
    'I will inspect it.',
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="execute_code">',
    '<｜DSML｜parameter name="code" string="true">print("ok")</｜DSML｜parameter>',
    '<｜DSML｜parameter name="timeout" string="false">30</｜DSML｜parameter>',
    '<｜DSML｜parameter name="capture" string="false">true</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜tool_calls>',
  ].join('\n');

  const call = serverInternals.parseToolCall(dsml);
  assert.equal(call.name, 'execute_code');
  assert.deepEqual(JSON.parse(call.arguments), {
    code: 'print("ok")',
    timeout: 30,
    capture: true,
  });
});

test('parseToolCall accepts the doubled-bar DSML Web variant from issue #19', () => {
  const dsml = [
    '<｜｜DSML｜｜ Tool Calls>',
    '<｜｜DSML｜｜ name="web_search">{"query":"DeepSeek DSML"}',
    '</｜｜DSML｜｜ Tool Calls>',
  ].join('\n');

  const call = serverInternals.parseToolCall(dsml);
  assert.equal(call.name, 'web_search');
  assert.deepEqual(JSON.parse(call.arguments), { query: 'DeepSeek DSML' });
});

test('parseToolCall accepts zero-argument, CDATA, legacy, collapsed, and prefixed wrappers', () => {
  const zeroArg = serverInternals.parseToolCall(
    '<|DSML|tool_calls><|DSML|invoke name="ping"></|DSML|invoke></|DSML|tool_calls>'
  );
  assert.deepEqual(zeroArg, { name: 'ping', arguments: '{}' });

  const cdata = serverInternals.parseToolCall(
    '<tool_calls><invoke name="write_file"><parameter name="content"><![CDATA[line 1\n<line 2>]]></parameter></invoke></tool_calls>'
  );
  assert.deepEqual(JSON.parse(cdata.arguments), { content: 'line 1\n<line 2>' });

  const collapsed = serverInternals.parseToolCall(
    '<DSMLtool_calls><DSMLinvoke name="read_file"><DSMLparameter name="path">/tmp/a</DSMLparameter></DSMLinvoke></DSMLtool_calls>'
  );
  assert.deepEqual(JSON.parse(collapsed.arguments), { path: '/tmp/a' });

  const prefixed = serverInternals.parseToolCall(
    '<abc:tool_calls><abc:invoke name="read_file"><abc:parameter name="path">/tmp/b</abc:parameter></abc:invoke></abc:tool_calls>'
  );
  assert.deepEqual(JSON.parse(prefixed.arguments), { path: '/tmp/b' });
});

test('parseToolCall normalizes fullwidth delimiters and narrowly repairs a missing opening wrapper', () => {
  const fullwidth = serverInternals.parseToolCall(
    '＜｜DSML｜Tool Calls＞＜｜DSML｜Invoke name=“read_file”＞＜｜DSML｜Parameter name=“path”＞/tmp/c＜/｜DSML｜Parameter＞＜/｜DSML｜Invoke＞＜/｜DSML｜Tool Calls＞'
  );
  assert.deepEqual(JSON.parse(fullwidth.arguments), { path: '/tmp/c' });

  const repaired = serverInternals.parseToolCall(
    '<invoke name="read_file"><parameter name="path">/tmp/d</parameter></invoke></tool_calls>'
  );
  assert.deepEqual(JSON.parse(repaired.arguments), { path: '/tmp/d' });
});

test('parseToolCall rejects bare invokes and bare JSON examples', () => {
  const bareInvoke = '<|DSML|invoke name="execute_code"><|DSML|parameter name="code">danger()</|DSML|parameter></|DSML|invoke>';
  assert.equal(serverInternals.parseToolCall(bareInvoke), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup(bareInvoke), true);

  const prose = 'For example return {"name":"execute_code","arguments":{"code":"danger()"}} when appropriate.';
  assert.equal(serverInternals.parseToolCall(prose), null);
  assert.equal(serverInternals.parseToolCall('```json\n{"name":"execute_code","arguments":{"code":"danger()"}}\n```'), null);
});

test('parseToolCall accepts only explicit JSON envelopes with valid object arguments', () => {
  const explicit = serverInternals.parseToolCall(
    'Use this: {"tool_call":{"name":"read_file","arguments":{"path":"/tmp/a"}}}'
  );
  assert.deepEqual(JSON.parse(explicit.arguments), { path: '/tmp/a' });

  const openai = serverInternals.parseToolCall(JSON.stringify({
    tool_calls: [{
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/b' }) },
    }],
  }));
  assert.deepEqual(JSON.parse(openai.arguments), { path: '/tmp/b' });

  assert.equal(serverInternals.parseToolCall('{"tool_call":{"name":"read_file","arguments":"not-json"}}'), null);
  assert.equal(serverInternals.parseToolCall(JSON.stringify({
    tool_calls: [
      { function: { name: 'read_file', arguments: '{}' } },
      { function: { name: 'write_file', arguments: '{}' } },
    ],
  })), null);
});

test('parseToolCall bounds tool markup and scans unmatched braces in linear time', () => {
  const oversized = `<|DSML|tool_calls>${'x'.repeat(256 * 1024)}</|DSML|tool_calls>`;
  assert.equal(serverInternals.parseToolCall(oversized), null);

  const started = Date.now();
  assert.equal(serverInternals.parseToolCall('{'.repeat(64 * 1024)), null);
  assert.ok(Date.now() - started < 1000, 'unmatched JSON braces should not block the event loop');
});

test('parseToolCall refuses incomplete DSML instead of executing JSON found inside it', () => {
  const malformed = [
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="execute_code">',
    '{"name":"dangerous_fallback","code":"rm -rf /"}',
    '</｜DSML｜tool_calls>',
  ].join('\n');

  assert.equal(serverInternals.parseToolCall(malformed), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup(malformed), true);
});

test('tool schema compaction drops prose annotations but preserves validation shape', () => {
  const compact = serverInternals.compactToolSchema({
    type: 'object',
    description: 'large top-level description',
    properties: {
      command: { type: 'string', description: 'large property description' },
      count: { type: 'integer', minimum: 1 },
    },
    required: ['command'],
  });

  assert.deepEqual(compact, {
    type: 'object',
    properties: {
      command: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
    },
    required: ['command'],
  });
});

test('buildBoundedPrompt preserves task edges and drops duplicate recovery history', () => {
  const system = `SYSTEM_START\n${'s'.repeat(50000)}\nTOOL_ADAPTER_END`;
  const history = `[Previous conversation]\n${'h'.repeat(10000)}\n`;
  const conversation = `TASK_START\n${'c'.repeat(70000)}\nLATEST_TOOL_RESULT`;
  const bounded = serverInternals.buildBoundedPrompt(system, history, conversation, 20000);

  assert.equal(bounded.compacted, true);
  assert.equal(bounded.historyDropped, true);
  assert.ok(bounded.prompt.length <= 20000);
  assert.match(bounded.prompt, /SYSTEM_START/);
  assert.match(bounded.prompt, /TOOL_ADAPTER_END/);
  assert.match(bounded.prompt, /TASK_START/);
  assert.match(bounded.prompt, /LATEST_TOOL_RESULT/);
  assert.doesNotMatch(bounded.prompt, /Previous conversation/);
});

test('client-provided multi-turn history suppresses server recovery-history injection', () => {
  assert.equal(serverInternals.hasExplicitConversationHistory([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hello' },
  ]), false);
  assert.equal(serverInternals.hasExplicitConversationHistory([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'tool', content: 'result' },
  ]), true);
});

test('context-too-long detector recognizes DeepSeek localized errors', () => {
  assert.equal(serverInternals.isContextTooLongError({ content: 'Содержание слишком длинное. Сократите его и попробуйте снова.' }), true);
  assert.equal(serverInternals.isContextTooLongError({ content: 'Maximum context length exceeded' }), true);
  assert.equal(serverInternals.isContextTooLongError({ content: 'Temporary backend overload' }), false);
});
