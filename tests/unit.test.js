const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

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

// ==========================================
// ИСХОДНЫЕ ТЕСТЫ (СОХРАНЕНЫ ПОЛНОСТЬЮ)
// ==========================================

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

// ==========================================
// ИСПРАВЛЕННЫЕ И ДОПОЛНЕННЫЕ ТЕСТЫ
// ==========================================

test('client.js exits with 1 and prints error when no auth is set', () => {
  const realAuth = path.join(ROOT, 'deepseek-auth.json');
  const tempAuth = path.join(ROOT, 'deepseek-auth.json.tmp');
  const hasRealAuth = fs.existsSync(realAuth);

  // Временно убираем конфигурационный файл из директории, чтобы заставить тест упасть
  if (hasRealAuth) {
    fs.renameSync(realAuth, tempAuth);
  }

  try {
    const res = runNode(['client.js', 'hello_prompt'], {
      env: {
        DEEPSEEK_TOKEN: '',
        DEEPSEEK_COOKIE: '',
        DEEPSEEK_AUTH_PATH: 'missing-file-to-force-fallback.json'
      }
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr + res.stdout, /Error: DeepSeek auth is not set/i);
  } finally {
    // Гарантированно возвращаем файл авторизации на место
    if (hasRealAuth) {
      fs.renameSync(tempAuth, realAuth);
    }
  }
});

test('auth import rejects invalid JSON input file', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'invalid.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, 'invalid-non-json-content');

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /Unexpected token/i);
  assert.equal(fs.existsSync(dst), false);
});

test('doctor reports success offline on fully valid auth file', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'valid-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    token: 'valid_tok_here',
    cookie: 'ds_session_id=123',
    wasmUrl: 'https://example.com/sha3.wasm'
  }));
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /auth file looks OK/i);
});

test('server.js guessExtension helper maps mime types correctly', () => {
  const serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // Используем точный маркер конца функции для корректного захвата тела
  const match = serverCode.match(/function guessExtension\([\s\S]*?return map\[mimeType\] \|\| 'png';\s*\}/);
  assert.ok(match, 'guessExtension helper function structure not found inside server.js');

  const guessExtension = new Function('mimeType', `${match[0]}\nreturn guessExtension(mimeType);`);

  assert.equal(guessExtension('image/png'), 'png');
  assert.equal(guessExtension('image/jpeg'), 'jpg');
  assert.equal(guessExtension('image/jpg'), 'jpg');
  assert.equal(guessExtension('image/webp'), 'webp');
  assert.equal(guessExtension('image/gif'), 'gif');
  assert.equal(guessExtension('application/octet-stream'), 'png');
});

test('server.js buildMultipartBody helper constructs valid multipart form data', () => {
  const serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const guessExtMatch = serverCode.match(/function guessExtension\([\s\S]*?return map\[mimeType\] \|\| 'png';\s*\}/);
  const buildMultipartMatch = serverCode.match(/function buildMultipartBody\([\s\S]*?return \{ body, contentType: `multipart\/form-data; boundary=\${boundary}` \};\s*\}/);

  assert.ok(guessExtMatch, 'guessExtension not found');
  assert.ok(buildMultipartMatch, 'buildMultipartBody not found');

  const buildMultipartBody = new Function('fields', 'binaryParts', `
    ${guessExtMatch[0]}
    ${buildMultipartMatch[0]}
    return buildMultipartBody(fields, binaryParts);
  `);

  const buffer = Buffer.from('mock_image_bytes');
  const result = buildMultipartBody({ prompt: 'test_vision' }, [{
    name: 'file',
    mimeType: 'image/png',
    buffer: buffer
  }]);

  assert.ok(Buffer.isBuffer(result.body));
  assert.match(result.contentType, /^multipart\/form-data; boundary=----FormBoundary/);

  const bodyStr = result.body.toString('utf8');
  assert.match(bodyStr, /name="prompt"/);
  assert.match(bodyStr, /test_vision/);
  assert.match(bodyStr, /name="file"; filename="file.png"/);
  assert.match(bodyStr, /Content-Type: image\/png/);
});