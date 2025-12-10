# A4F Proxy Debugging Notes

## Issue Summary

When using Roo Code with the A4F proxy, intermittent errors occur:
1. **"You exceeded your current quota"** - Error message from `platform.openai.com`
2. **"Empty assistant response"** - No content returned
3. **Path issues** - Double `/v1/v1/` or `//v1/` prefixes
4. **"Connection reset by peer"** - Client closes connection before server finishes writing
5. **"Waiting for tool result"** - Roo Code gets stuck waiting for tool call response

## Environment

- **Proxy**: Cloudflare Worker at `localhost:8787`
- **Backend**: A4F API (`https://api.a4f.co/v1`)
- **Client**: Roo Code VS Code extension
- **Model**: `gpt-5.1-codex-max` via Responses API
- **Tool Call Protocol**: XML (not native)

## Roo Code Configuration

```
API Provider: OpenAI
Use custom base URL: ✓
Base URL: http://localhost:8787 (or http://localhost:8787/v1)
Model: gpt-5.1-codex-max
Model Reasoning Effort: High
Tool Call Protocol: XML
```

## Key Findings

### 1. Path Normalization Issues

Roo Code uses **two different HTTP clients**:
- **Main client** (`qn/JS 5.12.2`): Correctly constructs paths
- **Subtask client** (`node`): Incorrectly constructs paths

| Base URL Setting | Main Client Path | Subtask Client Path | Result |
|------------------|------------------|---------------------|--------|
| `localhost:8787/v1` | `/v1/responses` ✓ | `/v1/v1/responses` ✗ | 404 |
| `localhost:8787` | `/responses` ✓ | `//v1/responses` ✗ | 404 |

**Fix implemented**: Path normalization in `src/index.ts`:
```typescript
// Case 1: Double /v1 prefix
if (pathname.startsWith("/v1/v1/")) {
  pathname = pathname.replace("/v1/v1/", "/v1/");
}
// Case 2: Double slash prefix
if (pathname.startsWith("//")) {
  pathname = pathname.replace(/^\/+/, "/");
}
```

### 2. Quota Error Mystery

**Critical observation**: The "quota exceeded" error mentions `platform.openai.com` - this is the **real OpenAI API**, not A4F.

**Evidence that proxy/A4F are working correctly**:
- All requests to proxy return `200 OK`
- A4F returns valid streaming responses (thousands of chunks)
- Direct tests to A4F work perfectly (10/10 requests succeed)
- Direct tests through proxy work perfectly (10/10 requests succeed)
- Stream content shows valid response data with `"error":null`

**Hypothesis**: Roo Code is making a **separate request to the real OpenAI API** somewhere in its code path, possibly:
- A fallback mechanism when something fails
- A separate API call for certain operations
- A bug in the subtask system

### 3. Tool Calling Issue

**A4F's Responses API does NOT support tool calling**:
```bash
# Test with tools parameter
curl -X POST "https://api.a4f.co/v1/responses" \
  -H "Authorization: Bearer $A4F_API_KEY" \
  -d '{"model": "provider-5/gpt-5.1-codex-max", "input": "test", "tools": [...]}'

# Result: 500 Internal Server Error
```

However, Roo Code is configured to use **XML tool format**, so it shouldn't be sending native tools. The logs confirm `Tools: 0` in all requests.

### 4. Empty Assistant Response

Sometimes the API returns a valid 200 OK but Roo Code shows "Empty assistant response". This could be:
- A4F returning an empty output array
- Parsing issue on Roo Code's side
- Stream ending prematurely

## Proxy Logs Analysis

### Successful Request Pattern
```
[wrangler:info] POST /v1/responses 200 OK (306ms)
[RESPONSES] A4F status: 200 for model: gpt-5.1-codex-max
[RESPONSES] Stream ended, total bytes: 45000
```

### Failed Request Pattern (Path Issue)
```
[wrangler:info] POST /v1/v1/responses 404 Not Found (4ms)
# or
[wrangler:info] POST //v1/responses 404 Not Found (4ms)
```

### Network Connection Lost
```
[ERROR] Uncaught Error: Network connection lost.
```
This appears when the client disconnects before the stream completes.

## Tests Performed

### 1. Direct A4F Test (10 requests)
```bash
for i in {1..10}; do
  curl -X POST "https://api.a4f.co/v1/responses" \
    -H "Authorization: Bearer $A4F_API_KEY" \
    -d '{"model": "provider-5/gpt-5.1-codex-max", "input": "Say hello"}'
done
# Result: 10/10 success
```

### 2. Proxy Test (10 requests)
```bash
for i in {1..10}; do
  curl -X POST "http://localhost:8787/v1/responses" \
    -H "Authorization: Bearer $VALID_API_KEY" \
    -d '{"model": "gpt-5.1-codex-max", "input": "Say hello"}'
done
# Result: 10/10 success
```

### 3. Tool Calling Test
```bash
curl -X POST "https://api.a4f.co/v1/responses" \
  -H "Authorization: Bearer $A4F_API_KEY" \
  -d '{"model": "provider-5/gpt-5.1-codex-max", "input": "test", "tools": [{"type": "function", ...}]}'
# Result: 500 Internal Server Error
```

## Recommended Next Steps

1. **Investigate Roo Code's subtask system**:
   - Check if there's a separate API configuration for subtasks
   - Look for fallback mechanisms that might call real OpenAI
   - Check the "Modes" settings for per-mode API configurations

2. **Check for multiple API configurations**:
   - Roo Code might have separate settings for different modes
   - The Configuration Profile might not apply to subtasks

3. **Monitor network traffic**:
   - Use browser dev tools or Wireshark to see ALL outgoing requests
   - Look for requests going to `api.openai.com` instead of `localhost:8787`

4. **Test with a simpler setup**:
   - Try using just Ask mode without Orchestrator
   - Disable subtask delegation temporarily

5. **Report to Roo Code team**:
   - The subtask client path construction bug (`/v1/v1/` and `//v1/`)
   - Possible fallback to real OpenAI API

## Files Modified

- `src/index.ts`:
  - Added path normalization for `/v1/v1/` and `//` prefixes
  - Added detailed logging for debugging quota errors
  - **Added `function_call` output type support** - The proxy now properly handles tool calls in the Responses API
  - **Added `response.output_text.done` SSE event** - Ensures proper stream termination for text content
  - **Added `response.function_call_arguments.delta/done` SSE events** - Proper streaming support for function calls
  - **Removed tool stripping** - Tools are no longer stripped from streaming requests; the proxy now properly handles function_call output items
  - **Added request ID logging** - All requests now have unique IDs for correlation in logs
  - **Added stream monitoring** - Transform stream monitors bytes/chunks and logs completion

## Latest Log Analysis

```
[RESPONSES] A4F status: 200 for model: gpt-5.1-codex-max
[wrangler:info] POST /responses 200 OK (710ms)
[ERROR] Uncaught Error: Network connection lost.
[ERROR] Uncaught Error: Network connection lost.
[RESPONSES] A4F status: 200 for model: gpt-5.1-codex-max
[wrangler:info] POST //v1/responses 200 OK (372ms)
[RESPONSES] Stream ended, total bytes: 196509
```

**Observations**:
1. The `//v1/responses` path is now returning 200 OK (path normalization working)
2. Stream completed with 196,509 bytes (valid response)
3. "Network connection lost" errors appear - client disconnecting prematurely
4. The quota error is NOT in the proxy logs - it's coming from elsewhere

## Current Proxy Code State

The proxy correctly:
- Normalizes malformed paths (`/v1/v1/` → `/v1/`, `//` → `/`)
- Forwards requests to A4F with `provider-5/` prefix
- Passes through SSE streams
- Handles CORS
- Validates API keys

**The proxy is NOT the source of the quota error.**

## Conclusion

The "quota exceeded" error referencing `platform.openai.com` is definitively NOT coming from:
- The A4F proxy (all requests return 200 OK)
- The A4F backend (valid responses with 196KB+ of data)

The error must be coming from Roo Code itself, possibly:
1. A hardcoded fallback to real OpenAI API
2. A separate API call for certain operations (like tool execution)
3. A cached/stale error message
4. A bug in error handling that shows wrong error messages

## Enhanced Logging (Added 2024)

To help identify if the "quota exceeded" error is coming from A4F upstream (which might use OpenAI as a backend), detailed logging has been added to the proxy:

### Log Format

All logs now include a unique request ID for correlation:
```
[req_1234567890_abc123] RESPONSES: model=gpt-5.1-codex-max, streaming=true, tools=0
```

### What's Logged

1. **Router Level** (`[ROUTER]`):
   - All incoming requests with method, path, and user-agent
   - Path normalization events (when `/v1/v1/` or `//` are fixed)
   - Route matching decisions
   - 404 not found events

2. **Responses API** (`[requestId] RESPONSES:`):
   - Request details (model, streaming, tools count)
   - A4F response status and fetch time
   - First chunk timing
   - Stream completion stats (bytes, chunks, total time)
   - **⚠️ Warnings** when errors contain "openai.com", "quota", or "rate_limit"
   - Empty response detection

3. **Chat Completions API** (`[requestId] CHAT:`):
   - Same logging as Responses API
   - Error detection in stream chunks

### Key Indicators to Watch For

Look for these log patterns to identify if A4F is returning OpenAI errors:

```
⚠️ ERROR CONTAINS OPENAI REFERENCE - A4F may be using OpenAI backend
⚠️ Chunk X contains error/quota reference: ...
⚠️ Stream contained error: ...
⚠️ EMPTY RESPONSE - 0 bytes received
```

### Running the Proxy with Logs

```bash
# Local development with live logs
bun run dev

# Production logs (Cloudflare)
bunx wrangler tail --format=pretty
```

### Expected Log Output for Successful Request

```
[ROUTER] POST /v1/responses - UA: node
[ROUTER] -> handleResponses
[req_1234_abc] RESPONSES: model=gpt-5.1-codex-max, streaming=true, tools=0
[req_1234_abc] RESPONSES: A4F status=200, fetchTime=150ms
[req_1234_abc] RESPONSES: First chunk received after 200ms
[req_1234_abc] RESPONSES: Stream complete - bytes=50000, chunks=100, totalTime=5000ms
```

### Expected Log Output if A4F Returns OpenAI Error

```
[req_1234_abc] RESPONSES: A4F status=429, fetchTime=100ms
[req_1234_abc] RESPONSES: A4F ERROR (429): {"error":{"message":"You exceeded your current quota...","type":"insufficient_quota"}}
[req_1234_abc] RESPONSES: ⚠️ ERROR CONTAINS OPENAI REFERENCE - A4F may be using OpenAI backend
```

## Recent Fixes (2024)

### Issue: "Connection reset by peer" and "Waiting for tool result"

**Root Causes Identified:**

1. **Missing `function_call` output type** - The proxy's `ResponsesOutputItem` type only supported `reasoning` and `message` types, not `function_call`. This meant tool calls from the model were not properly handled.

2. **Missing SSE events** - The `convertResponsesToSSE()` function was missing:
   - `response.output_text.done` event for text content completion
   - `response.function_call_arguments.delta` event for streaming function call arguments
   - `response.function_call_arguments.done` event for function call completion

3. **Tool stripping** - The proxy was stripping tools from streaming requests, which prevented the model from returning tool calls.

**Fixes Applied:**

1. Added `ResponsesFunctionCallItem` interface with proper fields:
   ```typescript
   interface ResponsesFunctionCallItem {
     id: string;
     type: "function_call";
     call_id: string;
     name: string;
     arguments: string;
     status: "completed" | "in_progress";
   }
   ```

2. Updated `ResponsesOutputItem` union type to include `ResponsesFunctionCallItem`

3. Added function_call handling in `convertResponsesToSSE()`:
   - `response.output_item.added` event with function_call item
   - `response.function_call_arguments.delta` event with arguments
   - `response.function_call_arguments.done` event with final arguments
   - `response.output_item.done` event with completed function_call

4. Added `response.output_text.done` event for proper text content completion

5. Removed tool stripping from streaming requests - tools are now passed through to A4F

6. Added comprehensive logging with request IDs for debugging

**Expected Behavior After Fix:**

- Tool calls should now be properly returned in the SSE stream
- Roo Code should receive `function_call` output items and process them correctly
- The "Waiting for tool result" state should resolve when the model returns tool calls
- Stream termination should be cleaner, reducing "Connection reset by peer" errors