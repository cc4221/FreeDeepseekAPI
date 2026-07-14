# Plan: Add Vision (Multimodal Image Recognition) Support to FreeDeepseekAPI

## Goal
Enable `deepseek-vision` model to accept OpenAI-compatible `image_url` messages by implementing the DeepSeek Web API file upload → fork → chat completion flow, using only Node.js built-in modules.

## Current State
- `server.js` is a single-file Node.js HTTP proxy with no external npm dependencies.
- `deepseek-vision` is defined in `MODEL_CONFIGS` but marked `supported: false`.
- `normalizeMessageContent()` currently converts `image_url` parts into placeholder strings (`[Image: ...]`), so images are lost before reaching DeepSeek.
- `askDeepSeekStream()` always sends `ref_file_ids: []` and does not distinguish vision upload flow.

## Proposed Changes (single file: `server.js`)

### 1. Enable Vision Model Config
- Change `deepseek-vision` in `MODEL_CONFIGS` to `supported: true`.
- Keep `model_type: 'vision'`, `search_enabled: false`, `thinking_enabled: false`.
- Note: Vision requests must force `search_enabled: false` (DeepSeek rejects simultaneous search + file analysis).

### 2. Extract Images from Incoming Messages
Add a helper `extractImagesFromMessages(messages)` that scans OpenAI-style `messages` for `image_url` parts:
- Supports `data:image/<fmt>;base64,...` and plain base64 data URLs.
- Supports `image` Anthropic-style parts with `source.data`.
- Returns an array of objects: `{ mimeType, buffer }`.
- Replaces image parts in the normalized prompt with a short text reference like `[IMAGE:<mime>]` so the text prompt remains coherent.

### 3. Build Multipart Body Without External Libraries
Add a pure-Node.js multipart/form-data encoder:
- Takes fields and binary parts, generates random `boundary`.
- Returns `{ body: Buffer, contentType: 'multipart/form-data; boundary=...' }`.
- Used only for the `/api/v0/file/upload_file` endpoint.

### 4. Implement File Upload to DeepSeek
Add `async function uploadFileToDeepSeek(account, buffer, mimeType)`:
- `POST https://chat.deepseek.com/api/v0/file/upload_file`
- Headers: reuse `account.headers`, but replace `Content-Type` with the multipart boundary.
- Body: multipart with `file` field containing the image buffer.
- Parse JSON response to extract primary `file_id`.
- Throw on non-200 with account cooldown handling.

### 5. Implement Fork for Vision
Add `async function forkFileForVision(account, fileId)`:
- `POST https://chat.deepseek.com/api/v0/file/fork_file_task`
- Headers: same account headers, `Content-Type: application/json`.
- Body: `{ file_id, target_model: 'vision' }`.
- Parse response for the new/forked `file_id`.
- If backend returns a task ID instead of ready file, implement a short polling loop against `/api/v0/file/fetch_files` (max ~10s) to retrieve the ready ID.

### 6. Modify `askDeepSeekStream` Signature
Update signature to:
```js
async function askDeepSeekStream(prompt, agentId, model = 'deepseek-default', refFileIds = [])
```
- Pass `ref_file_ids: refFileIds` into the completion request body.
- For vision model: ensure `search_enabled` is forced to `false` even if config says otherwise.
- Add retry logic: if DeepSeek returns `backend_err_by_model` or file-not-found, clear the session and retry once with a fresh upload path.

### 7. Wire Upload Into Request Flow
In the main POST handler (before calling `askDeepSeekStream`):
1. Detect if `requestedModel` is `deepseek-vision`.
2. Call `extractImagesFromMessages(params.messages)` to get image buffers.
3. For each image:
   - Upload via `uploadFileToDeepSeek`.
   - Fork via `forkFileForVision`.
   - Collect forked `file_id`s.
4. If upload/fork fails for any image, return a structured JSON error (422 or 502) with the DeepSeek response text.
5. Pass collected `refFileIds` to `askDeepSeekStream`.

### 8. Account Cooldown & Error Handling
- Reuse existing `markAccountFailure` and `readDeepSeekJsonResponse` patterns.
- On upload/fork 403/429, trigger account cooldown same as chat completion.
- Log upload/fork steps with `[agentTag]` prefix for traceability.

### 9. Validation Steps
- `GET /v1/model-capabilities` should now list `deepseek-vision` with `supported: true` and `vision: true`.
- Health/model endpoints remain unchanged.
- Manual test: send OpenAI-compatible request with a small PNG base64 in `image_url`; expect non-error completion.

## Risks & Mitigations
- **Cloudflare hardening on upload endpoints**: Mitigation — mimic existing web headers exactly (`x-client-platform`, `x-client-version`, etc.) and keep multipart minimal. If Cloudflare still blocks, the proxy should return a clear error suggesting auth refresh.
- **Fork latency**: Mitigation — poll with 500ms interval, cap at ~10s, then fail fast with actionable error.
- **Memory**: Images are small buffers per request; no persistent storage needed.

## File Scope
Only `C:\ai\ai\FreeDeepseekAPI\server.js` is modified. No new files, no new npm dependencies.

## Open Questions
None. Implementation path is clear from existing code patterns.
