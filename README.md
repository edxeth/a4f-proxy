# A4F Anthropic Proxy

A high-performance Python proxy server that converts Anthropic's `v1/messages` API format to A4F's OpenAI-compatible chat completions API. This enables tools like Roo Code, Cline, and other Anthropic API clients to work seamlessly with A4F's API gateway.

## Features

- ✅ Converts Anthropic `v1/messages` API to OpenAI `chat/completions` format
- ✅ Full streaming support with proper SSE event conversion
- ✅ Handles system prompts (Anthropic uses top-level `system` parameter)
- ✅ Handles multi-modal content (images)
- ✅ Handles tool calling (both directions)
- ✅ Validates that only Claude models are used
- ✅ Automatic model name prefixing (`provider-7/` prefix for A4F)
- ✅ Accurate token counting using tiktoken estimation
- ✅ Detailed request/response logging for debugging

## Requirements

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

## Installation

### Using uv (Recommended)

```bash
# Clone or navigate to the project
cd a4f-proxy

# Create virtual environment and install dependencies
uv venv
uv pip install -r requirements.txt
```

### Using pip

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

## Usage

### Start the proxy server

```bash
# Using uv
uv run python proxy.py

# Or activate venv first
source venv/bin/activate  # or: source .venv/bin/activate
python proxy.py

# With auto-reload for development
uvicorn proxy:app --host 0.0.0.0 --port 4242 --reload
```

The proxy will start on port `4242` by default. Change this with the `PORT` environment variable:

```bash
PORT=8080 uv run python proxy.py
```

### Running in tmux (Recommended for persistent sessions)

```bash
# Start in a new tmux session
tmux new-session -d -s a4f-proxy "cd /path/to/a4f-proxy && uv run python proxy.py"

# Attach to view logs
tmux attach -t a4f-proxy

# Detach: Press Ctrl+B, then D
```

### Test the proxy

```bash
# Health check
curl http://localhost:4242/health

# Non-streaming request
curl -X POST http://localhost:4242/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_A4F_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-5-20251101",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming request
curl -X POST http://localhost:4242/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_A4F_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-5-20251101",
    "max_tokens": 100,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

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
| **Anthropic API Key** | Your A4F API key (e.g., `ddc-a4f-xxxxx`) |
| **Use custom base URL** | ✅ Checked |
| **Custom Base URL** | `http://localhost:4242` |
| **Model** | `claude-opus-4-5-20251101` (or any Claude model) |
| **Tool Call Protocol** | `XML` (recommended for A4F) |

### Important Notes

- **Model Name**: Use the model name WITHOUT the provider prefix:
  - ✅ Correct: `claude-opus-4-5-20251101`
  - ❌ Wrong: `provider-7/claude-opus-4-5-20251101`
  
  The proxy automatically adds the `provider-7/` prefix when forwarding to A4F.

- **Tool Call Protocol**: Set to `XML` because A4F doesn't support native function calling for Claude models.

- **Base URL**: Make sure the proxy is running before using!

## Available Models

Based on A4F's model naming convention:

- `claude-opus-4-5-20251101`
- `claude-sonnet-4-20250514`
- `claude-3-5-sonnet-20241022`
- `claude-3-haiku-20240307`

Check A4F's documentation for the full list of available models.

## Architecture

```
┌─────────────┐     Anthropic API      ┌─────────────────┐     OpenAI API      ┌───────────┐
│  Roo Code   │ ───────────────────►   │  A4F Proxy      │ ──────────────────► │   A4F     │
│  (Client)   │     v1/messages        │  (localhost)    │   chat/completions  │   API     │
└─────────────┘                        └─────────────────┘                     └───────────┘
                                              │
                                              ▼
                                    ┌─────────────────────┐
                                    │ Format Conversion:  │
                                    │ - Messages format   │
                                    │ - System prompts    │
                                    │ - Tool calls        │
                                    │ - Streaming events  │
                                    │ - Model prefix      │
                                    │ - Token counting    │
                                    └─────────────────────┘
```

## API Endpoints

### POST /v1/messages
Main endpoint that proxies Anthropic Messages API requests to A4F.

**Headers:**
- `Content-Type: application/json`
- `x-api-key: <your-a4f-api-key>` OR `Authorization: Bearer <your-a4f-api-key>`
- `anthropic-version: 2023-06-01` (optional)

**Request Body:** Anthropic Messages API format

**Response:** Anthropic Messages API format (or SSE stream if `stream: true`)

### POST /v1/messages/count_tokens
Token counting endpoint using tiktoken estimation.

**Response:**
```json
{"input_tokens": 12345}
```

### GET /health
Health check endpoint.

**Response:**
```json
{"status": "ok", "service": "a4f-anthropic-proxy"}
```

## Token Counting

The proxy uses `tiktoken` with the `cl100k_base` encoding to estimate token counts. This provides a reasonable approximation (~2-5% variance from actual Claude token counts).

**Why tiktoken?**
- Anthropic doesn't provide a public tokenizer library
- The official `/v1/messages/count_tokens` API adds latency
- `cl100k_base` (GPT-4's tokenizer) provides good estimates for Claude

**How it works:**
- Input tokens are estimated using tiktoken before streaming starts
- Output tokens are taken from A4F's actual usage data
- Both are reported in Anthropic's SSE format for proper client display

## Troubleshooting

### Connection refused
Make sure the proxy is running on the expected port (default: 4242).

```bash
curl http://localhost:4242/health
```

### Model not found
Ensure the model name contains "claude" and is available on A4F.

### Streaming issues
The proxy converts OpenAI's streaming format to Anthropic's SSE format. If you see issues:
1. Check proxy logs: `tmux attach -t a4f-proxy`
2. Ensure your client handles SSE properly

### Token count mismatch
The tiktoken estimate may differ from actual Claude tokens by ~2-5%. This is expected since Claude uses a proprietary tokenizer.

## Development

```bash
# Run with auto-reload
uvicorn proxy:app --host 0.0.0.0 --port 4242 --reload

# Or with uv
uv run uvicorn proxy:app --host 0.0.0.0 --port 4242 --reload
```

## Dependencies

- **FastAPI** - Modern async web framework
- **httpx** - Async HTTP client with streaming support
- **uvicorn** - ASGI server with uvloop for performance
- **tiktoken** - Token counting estimation

## License

ISC
