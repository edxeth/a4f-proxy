# Devkit Anthropic Proxy

A CloudFlare Worker that proxies Anthropic's `v1/messages` API to A4F's OpenAI-compatible API, enabling tools like Roo Code, Cline, and other Anthropic API clients to work seamlessly with A4F's API gateway.

## Features

- ✅ **POST /v1/messages** - Main Anthropic Messages API endpoint
- ✅ **POST /v1/messages/count_tokens** - Token counting endpoint
- ✅ **GET /v1/models** - List available Claude models
- ✅ **GET /health** - Health check endpoint
- ✅ Full streaming support with proper SSE event conversion
- ✅ Dual authentication: `x-api-key` header (Anthropic) or `Authorization: Bearer` (OpenAI)
- ✅ Handles system prompts, multi-modal content (images), and tool calling
- ✅ Accurate token counting using `@lenml/tokenizer-claude`
- ✅ CORS support for browser-based clients

---

## Local Development

### Prerequisites

- [Bun](https://bun.sh/) runtime installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (included via `bunx`)

### Install Dependencies

```bash
bun install
```

### Create Local Secrets File

Create a `.dev.vars` file (already in `.gitignore`):

```bash
# .dev.vars
A4F_API_KEY=your-real-a4f-api-key
VALID_API_KEYS=test-key-1,test-key-2
```

### Run Locally

```bash
bun run dev
# Or: bunx wrangler dev
```

The worker will start on `http://localhost:8787`.

### Type Checking

```bash
bun run typecheck
```

---

## CloudFlare Worker

### ⚠️ Enabling/Disabling the Worker

**IMPORTANT:** For security and cost control, you should disable the worker when not in use.

#### Disable the Worker (Recommended when not in use)

Disabling stops all traffic to the worker but preserves your configuration and secrets.

**Via CLI:**
```bash
bunx wrangler disable
```

**Via CloudFlare Dashboard:**
1. Go to [CloudFlare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages**
3. Click on **devkit-anthropic-proxy**
4. Go to **Settings**
5. Click **Disable**

#### Enable the Worker

**Via CLI:**
```bash
bunx wrangler enable
```

**Via CloudFlare Dashboard:**
1. Go to [CloudFlare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages**
3. Click on **devkit-anthropic-proxy**
4. Go to **Settings**
5. Click **Enable**

> **Note:** Disabling the worker is non-destructive. All secrets, configuration, and code are preserved. You can re-enable at any time.

### Deployment

#### Prerequisites

- CloudFlare account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (included via `bunx`)

#### Initial Setup

```bash
# Login to CloudFlare (first time only)
bunx wrangler login

# Set up required secrets
bunx wrangler secret put A4F_API_KEY
# When prompted, enter your A4F API key

bunx wrangler secret put VALID_API_KEYS
# When prompted, enter comma-separated keys: key1,key2,key3

# Deploy
bun run deploy
```

#### Deploy Updates

```bash
bun run deploy
# Or: bunx wrangler deploy
```

#### View Deployment Versions

**Via CLI:**
```bash
bunx wrangler deployments list
```

**Via Dashboard:**
1. Go to **Workers & Pages** → **devkit-anthropic-proxy**
2. Click on **Deployments** tab

#### Rollback to Previous Version

```bash
bunx wrangler rollback
```

### Managing API Keys

This worker uses a dual-key authentication system:

1. **A4F API Key** (`A4F_API_KEY`): Your real A4F API key (never exposed to users)
2. **User API Keys** (`VALID_API_KEYS`): Keys you distribute to your users/clients

#### Update the Backend A4F Key

```bash
bunx wrangler secret put A4F_API_KEY
# When prompted, enter your A4F API key
```

#### Update User Keys

User keys are stored as a comma-separated list:

```bash
bunx wrangler secret put VALID_API_KEYS
# When prompted, enter: key1,key2,key3
```

Example input:
```
kL5vJ2fL3oO8cH3iO4lU5eT0uX9wP7rJ,aB2cD4eF6gH8iJ0kL2mN4oP6qR8sT0uV
```

#### List Current Secrets

```bash
bunx wrangler secret list
```

This shows secret names (not values) that are currently configured.

#### Delete a Secret

```bash
bunx wrangler secret delete SECRET_NAME
```

#### Generating Secure User Keys

Generate cryptographically secure random keys:

```bash
# Using openssl (32 hex characters)
openssl rand -hex 16

# Using openssl (longer key)
openssl rand -hex 32

# Using Node.js
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

# Using Python
python3 -c "import secrets; print(secrets.token_hex(16))"
```

### Monitoring & Logs

#### View Real-Time Logs

Stream live logs from the production worker:

```bash
bunx wrangler tail
```

With pretty formatting:
```bash
bunx wrangler tail --format=pretty
```

Filter by status:
```bash
# Only errors
bunx wrangler tail --status=error

# Only successful requests
bunx wrangler tail --status=ok
```

#### CloudFlare Dashboard Analytics

1. Go to [CloudFlare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages** → **devkit-anthropic-proxy**
3. View the **Analytics** tab for:
   - Request counts
   - Error rates
   - CPU time usage
   - Geographic distribution

---

## API Endpoints

### Health Check

```bash
curl http://localhost:8787/health
```

Response:
```json
{"status":"ok","service":"devkit-anthropic-proxy"}
```

### List Models

```bash
curl http://localhost:8787/v1/models
```

### Messages (Non-Streaming)

```bash
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_USER_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Messages (Streaming)

```bash
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_USER_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 100,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Count Tokens

```bash
curl -X POST http://localhost:8787/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_USER_API_KEY" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{"role": "user", "content": "Hello, world!"}]
  }'
```

Response:
```json
{"input_tokens": 4}
```

---

## Security Best Practices

1. **Keep the worker disabled when not in use** - This prevents unauthorized access and unexpected costs

2. **Rotate user keys periodically** - Generate new keys and update `VALID_API_KEYS` regularly

3. **Use strong, random keys** - Always use cryptographically secure random generators

4. **Monitor usage via CloudFlare Dashboard** - Check for unusual patterns or unauthorized access attempts

5. **Never commit secrets** - The `.dev.vars` file is gitignored; never put real keys in `wrangler.toml`

6. **Limit key distribution** - Only share user keys with trusted parties

---

## Roo Code / Cline Configuration

To use this proxy with Roo Code v3.35.3+ or Cline, configure the Anthropic provider:

### Step-by-Step Configuration

1. **Open Settings** → Go to **Providers** tab

2. **Create a new Configuration Profile**:
   - Click the `+` button next to "Configuration Profile"
   - Name it something like "A4F Claude Proxy"

3. **Configure the settings**:

| Setting | Value |
|---------|-------|
| **API Provider** | `Anthropic` |
| **Anthropic API Key** | Your user API key (from `VALID_API_KEYS`) |
| **Use custom base URL** | ✅ Checked |
| **Custom Base URL** | `https://your-worker-name.your-subdomain.workers.dev` |
| **Model** | `claude-sonnet-4-5-20250929` (or any Claude model) |
| **Tool Call Protocol** | `XML` (recommended for A4F) |

### Important Notes

- **Model Name**: Use the model name WITHOUT the provider prefix:
  - ✅ Correct: `claude-sonnet-4-5-20250929`
  - ❌ Wrong: `provider-7/claude-sonnet-4-5-20250929`
  
  The proxy automatically adds the `provider-7/` prefix when forwarding to A4F.

- **Tool Call Protocol**: Set to `XML` because A4F doesn't support native function calling for Claude models.

---

## Troubleshooting

### "Missing API key" Error

**Cause:** No API key provided in the request.

**Solution:** Include either:
- `x-api-key: YOUR_KEY` header (Anthropic style)
- `Authorization: Bearer YOUR_KEY` header (OpenAI style)

### "Invalid API key" Error

**Cause:** The provided key is not in the `VALID_API_KEYS` list.

**Solution:**
1. Verify the key is correct
2. Check that `VALID_API_KEYS` is set: `bunx wrangler secret list`
3. Update the keys if needed: `bunx wrangler secret put VALID_API_KEYS`

### "Server configuration error: A4F API key not configured"

**Cause:** The `A4F_API_KEY` secret is not set.

**Solution:**
```bash
bunx wrangler secret put A4F_API_KEY
```

### Worker Returns 404

**Cause:** The worker may be disabled or the endpoint doesn't exist.

**Solution:**
1. Enable the worker: `bunx wrangler enable`
2. Verify the endpoint path (e.g., `/v1/messages` not `/messages`)

### Streaming Not Working

**Cause:** Client may not support SSE or connection is being buffered.

**Solution:**
1. Ensure `stream: true` is in the request body
2. Check that your client supports Server-Sent Events
3. Disable any response buffering in proxies/load balancers

### Token Count Mismatch

**Cause:** Token counting uses `@lenml/tokenizer-claude` which may differ slightly from Anthropic's internal tokenizer.

**Solution:** This is expected behavior. The counts are accurate for billing estimation but may vary by a few tokens from Anthropic's official API.

### Deployment Fails

**Cause:** Various issues with wrangler or CloudFlare account.

**Solution:**
1. Ensure you're logged in: `bunx wrangler login`
2. Check your CloudFlare account has Workers enabled
3. Verify `wrangler.toml` syntax is correct
4. Try: `bunx wrangler deploy --dry-run` to test without deploying

---

## Architecture

```
User Request (Anthropic format)
        │
        ▼
┌─────────────────────────────┐
│   CloudFlare Worker         │
│   ┌─────────────────────┐   │
│   │ Validate User Key   │   │
│   └─────────────────────┘   │
│            │                │
│            ▼                │
│   ┌─────────────────────┐   │
│   │ Convert Anthropic   │   │
│   │ → OpenAI Format     │   │
│   └─────────────────────┘   │
│            │                │
│            ▼                │
│   ┌─────────────────────┐   │
│   │ Forward to A4F      │   │
│   │ (with A4F_API_KEY)  │   │
│   └─────────────────────┘   │
│            │                │
│            ▼                │
│   ┌─────────────────────┐   │
│   │ Convert OpenAI      │   │
│   │ → Anthropic Format  │   │
│   └─────────────────────┘   │
└─────────────────────────────┘
        │
        ▼
User Response (Anthropic format)
```

---

## Available Models

Models available via the `/v1/models` endpoint:

- `claude-opus-4-5-20251101`
- `claude-sonnet-4-5-20250929`
- `claude-sonnet-4-20250514`
- `claude-3-7-sonnet-20250219`
- `claude-3-5-sonnet-20241022`
- `claude-3-5-sonnet-20240620`
- `claude-3-5-haiku-20241022`
- `claude-haiku-4-5-20251001`
- `claude-3-haiku-20240307`

Check A4F's documentation for the full list of available models.

---

## License

ISC