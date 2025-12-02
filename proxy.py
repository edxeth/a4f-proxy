#!/usr/bin/env python3
"""A4F Anthropic Proxy Server - Converts Anthropic v1/messages API to A4F's OpenAI-compatible API."""

import json, os, uuid
from typing import Any, Optional, Union
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn
import tiktoken

# Initialize tokenizer (cl100k_base is a good approximation for Claude)
_tokenizer = None
def get_tokenizer():
    global _tokenizer
    if _tokenizer is None:
        _tokenizer = tiktoken.get_encoding("cl100k_base")
    return _tokenizer

def estimate_tokens(text: str) -> int:
    """Count tokens using tiktoken (approximate for Claude)."""
    return len(get_tokenizer().encode(text))

A4F_BASE_URL = "https://api.a4f.co/v1"
A4F_PROVIDER_PREFIX = "provider-7"
PORT = int(os.environ.get("PORT", 4242))

# Global HTTP client for streaming (kept alive)
_http_client: Optional[httpx.AsyncClient] = None

async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(timeout=300.0)
    return _http_client

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"\n🚀 A4F Anthropic Proxy Server started on port {PORT}")
    print(f"📡 Listening at http://localhost:{PORT}/v1/messages")
    print(f"🔄 Proxying to {A4F_BASE_URL}/chat/completions")
    print(f"📦 Using provider prefix: {A4F_PROVIDER_PREFIX}\n✨ Ready!\n")
    yield
    # Cleanup
    global _http_client
    if _http_client:
        await _http_client.aclose()

app = FastAPI(title="A4F Anthropic Proxy", lifespan=lifespan)

def validate_model(model: str) -> tuple[bool, Optional[str]]:
    if "claude" not in model:
        return False, f'Model "{model}" is not a Claude model. Only Claude models are supported.'
    return True, None

def content_to_string(content: Union[str, list]) -> str:
    if isinstance(content, str): return content
    return "".join(b.get("text", "") for b in content if b.get("type") == "text")

def convert_messages(msgs: list, system: Optional[Union[str, list]] = None) -> list:
    result = []
    if system:
        txt = system if isinstance(system, str) else "\n".join(b.get("text", "") for b in system if b.get("type") == "text")
        result.append({"role": "system", "content": txt})
    for msg in msgs:
        content, role = msg.get("content"), msg.get("role")
        if isinstance(content, str):
            result.append({"role": role, "content": content})
        elif isinstance(content, list):
            tool_use = [b for b in content if b.get("type") == "tool_use"]
            tool_result = [b for b in content if b.get("type") == "tool_result"]
            text = [b for b in content if b.get("type") == "text"]
            image = [b for b in content if b.get("type") == "image"]
            if tool_use and role == "assistant":
                calls = [{"id": b.get("id", f"call_{uuid.uuid4().hex[:12]}"), "type": "function",
                          "function": {"name": b.get("name", ""), "arguments": json.dumps(b.get("input", {}))}} for b in tool_use]
                result.append({"role": "assistant", "content": "".join(b.get("text", "") for b in text) if text else None, "tool_calls": calls})
            elif tool_result:
                for b in tool_result:
                    rc = b.get("content", "")
                    result.append({"role": "tool", "content": rc if isinstance(rc, str) else content_to_string(rc), "tool_call_id": b.get("tool_use_id", "")})
            elif image or text:
                parts = []
                for b in content:
                    if b.get("type") == "text" and b.get("text"): parts.append({"type": "text", "text": b["text"]})
                    elif b.get("type") == "image" and b.get("source"):
                        s = b["source"]
                        parts.append({"type": "image_url", "image_url": {"url": f"data:{s.get('media_type', 'image/png')};base64,{s.get('data', '')}"}})
                result.append({"role": role, "content": parts[0]["text"] if len(parts) == 1 and parts[0].get("type") == "text" else parts})
    return result

def convert_tools(tools: Optional[list]) -> Optional[list]:
    if not tools: return None
    return [{"type": "function", "function": {"name": t.get("name"), "description": t.get("description"), "parameters": t.get("input_schema", {})}} for t in tools]

def convert_tool_choice(choice: Optional[dict]) -> Optional[Union[str, dict]]:
    if not choice: return None
    t = choice.get("type")
    if t == "auto": return "auto"
    if t == "any": return "required"
    if t == "none": return "none"
    if t == "tool": return {"type": "function", "function": {"name": choice.get("name", "")}}
    return "auto"

def convert_request(req: dict) -> dict:
    r = {"model": f"{A4F_PROVIDER_PREFIX}/{req['model']}", "messages": convert_messages(req.get("messages", []), req.get("system")),
         "max_tokens": req.get("max_tokens"), "stream": req.get("stream", False)}
    if req.get("stream"): r["stream_options"] = {"include_usage": True}
    if "temperature" in req: r["temperature"] = req["temperature"]
    if "top_p" in req: r["top_p"] = req["top_p"]
    if "stop_sequences" in req: r["stop"] = req["stop_sequences"]
    if "tools" in req: r["tools"] = convert_tools(req["tools"])
    if "tool_choice" in req: r["tool_choice"] = convert_tool_choice(req["tool_choice"])
    if req.get("metadata", {}).get("user_id"): r["user"] = req["metadata"]["user_id"]
    return r

def generate_message_id() -> str: return f"msg_{uuid.uuid4().hex}"

def convert_response(res: dict, model: str) -> dict:
    choice = res.get("choices", [{}])[0]
    msg = choice.get("message", {})
    content = []
    if msg.get("content"): content.append({"type": "text", "text": msg["content"]})
    if msg.get("tool_calls"):
        for tc in msg["tool_calls"]:
            try: inp = json.loads(tc.get("function", {}).get("arguments", "{}"))
            except: inp = {}
            content.append({"type": "tool_use", "id": tc.get("id"), "name": tc.get("function", {}).get("name"), "input": inp})
    fr = choice.get("finish_reason", "")
    sr = "end_turn" if fr == "stop" else "max_tokens" if fr == "length" else "tool_use" if fr == "tool_calls" else "end_turn"
    return {"id": generate_message_id(), "type": "message", "role": "assistant", "content": content, "model": model,
            "stop_reason": sr, "stop_sequence": None, "usage": {"input_tokens": res.get("usage", {}).get("prompt_tokens", 0),
            "output_tokens": res.get("usage", {}).get("completion_tokens", 0)}}

def estimate_request_tokens(openai_req: dict) -> int:
    """Estimate input tokens from the OpenAI request using tiktoken."""
    total = 0
    for msg in openai_req.get("messages", []):
        content = msg.get("content")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            for part in content:
                if part.get("type") == "text" and part.get("text"):
                    total += estimate_tokens(part["text"])
        # Add overhead for role and message structure
        total += 4
    # Add tool definitions if present
    if openai_req.get("tools"):
        total += estimate_tokens(json.dumps(openai_req["tools"]))
    return total

async def stream_and_convert(api_key: str, openai_req: dict, model: str):
    """Stream from A4F and convert to Anthropic SSE format."""
    msg_id = generate_message_id()
    out_tok, idx = 0, 0
    txt_started, tool_started = False, False
    stop = "end_turn"
    
    # Pre-calculate input tokens using tiktoken (Anthropic expects this in message_start)
    estimated_input_tokens = estimate_request_tokens(openai_req)
    print(f"=== Estimated Input Tokens: {estimated_input_tokens}")
    
    # Send message_start event with estimated input_tokens
    yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'content': [], 'model': model, 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': estimated_input_tokens, 'output_tokens': 1}}})}\n\n"
    
    client = await get_http_client()
    
    try:
        async with client.stream(
            "POST",
            f"{A4F_BASE_URL}/chat/completions",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            json=openai_req
        ) as response:
            if not response.is_success:
                err_body = await response.aread()
                yield f"event: error\ndata: {json.dumps({'type': 'error', 'error': {'type': 'api_error', 'message': err_body.decode()}})}\n\n"
                return
            
            buf = ""
            async for chunk in response.aiter_text():
                buf += chunk
                lines = buf.split("\n")
                buf = lines.pop()
                
                for line in lines:
                    if not line.startswith("data: "): 
                        continue
                    data = line[6:]
                    if data == "[DONE]": 
                        continue
                    
                    try:
                        d = json.loads(data)
                        ch = d.get("choices", [{}])[0]
                        delta = ch.get("delta", {})
                        
                        if d.get("usage"):
                            print(f"=== A4F Usage Data: {d['usage']}")
                            # Only track output tokens - input tokens already sent in message_start
                            out_tok = d["usage"].get("completion_tokens", out_tok)
                        
                        if ch.get("finish_reason"):
                            fr = ch["finish_reason"]
                            stop = "end_turn" if fr == "stop" else "max_tokens" if fr == "length" else "tool_use" if fr == "tool_calls" else stop
                        
                        if delta.get("content"):
                            if not txt_started:
                                txt_started = True
                                yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'text', 'text': ''}})}\n\n"
                            yield f"event: content_block_delta\ndata: {json.dumps({'type': 'content_block_delta', 'index': idx, 'delta': {'type': 'text_delta', 'text': delta['content']}})}\n\n"
                        
                        if delta.get("tool_calls"):
                            for tc in delta["tool_calls"]:
                                if tc.get("id"):
                                    if txt_started:
                                        yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': idx})}\n\n"
                                        idx += 1
                                        txt_started = False
                                    if tool_started:
                                        yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': idx})}\n\n"
                                        idx += 1
                                    tool_started = True
                                    yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'tool_use', 'id': tc['id'], 'name': tc.get('function', {}).get('name', ''), 'input': {}}})}\n\n"
                                if tc.get("function", {}).get("arguments"):
                                    yield f"event: content_block_delta\ndata: {json.dumps({'type': 'content_block_delta', 'index': idx, 'delta': {'type': 'input_json_delta', 'partial_json': tc['function']['arguments']}})}\n\n"
                    except json.JSONDecodeError as e:
                        print(f"SSE parse error: {e}")
        
        # Close content blocks
        if txt_started or tool_started:
            yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': idx})}\n\n"
        
        # Send final events - Anthropic format: message_delta only has output_tokens
        print(f"=== Final Usage - Output: {out_tok}")
        yield f"event: message_delta\ndata: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': out_tok}})}\n\n"
        yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n"
        
    except Exception as e:
        print(f"Streaming error: {e}")
        yield f"event: error\ndata: {json.dumps({'type': 'error', 'error': {'type': 'api_error', 'message': str(e)}})}\n\n"

@app.post("/v1/messages")
async def handle_messages(request: Request):
    headers = dict(request.headers)
    try: 
        body = await request.json()
    except Exception as e: 
        return JSONResponse(status_code=400, content={"type": "error", "error": {"type": "invalid_request_error", "message": str(e)}})
    
    print(f"\n=== Anthropic Request ===\nHeaders: {json.dumps(headers, indent=2)}\nBody: {json.dumps(body, indent=2)}")
    
    api_key = headers.get("x-api-key") or (headers.get("authorization", "")[7:] if headers.get("authorization", "").startswith("Bearer ") else None)
    if not api_key: 
        return JSONResponse(status_code=401, content={"type": "error", "error": {"type": "authentication_error", "message": "Missing API key"}})
    
    valid, err = validate_model(body.get("model", ""))
    if not valid: 
        return JSONResponse(status_code=400, content={"type": "error", "error": {"type": "invalid_request_error", "message": err}})
    
    openai_req = convert_request(body)
    print(f"\n=== OpenAI Request ===\n{json.dumps(openai_req, indent=2)}")
    
    if body.get("stream"):
        # Streaming request - return generator directly
        return StreamingResponse(
            stream_and_convert(api_key, openai_req, body["model"]),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
        )
    else:
        # Non-streaming request
        client = await get_http_client()
        try:
            resp = await client.post(
                f"{A4F_BASE_URL}/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json=openai_req
            )
            if not resp.is_success:
                return JSONResponse(status_code=resp.status_code, content={"type": "error", "error": {"type": "api_error", "message": resp.text}})
            result = convert_response(resp.json(), body["model"])
            print(f"\n=== Response ===\n{json.dumps(result, indent=2)}")
            return JSONResponse(content=result)
        except Exception as e:
            return JSONResponse(status_code=500, content={"type": "error", "error": {"type": "api_error", "message": str(e)}})

@app.post("/v1/messages/count_tokens")
async def count_tokens_endpoint(request: Request):
    body = await request.json()
    total_tokens = 0
    
    # Count system prompt tokens
    system_tokens = 0
    if body.get("system"):
        if isinstance(body["system"], str):
            system_tokens = estimate_tokens(body["system"])
        else:
            for block in body["system"]:
                if block.get("type") == "text" and block.get("text"):
                    system_tokens += estimate_tokens(block["text"])
        total_tokens += system_tokens
    
    # Count message tokens
    message_tokens = 0
    for msg in body.get("messages", []):
        content = msg.get("content")
        if isinstance(content, str):
            message_tokens += estimate_tokens(content)
        elif isinstance(content, list):
            for block in content:
                if block.get("type") == "text" and block.get("text"):
                    message_tokens += estimate_tokens(block["text"])
    total_tokens += message_tokens
    
    # Count tool definitions tokens (if present)
    tool_tokens = 0
    if body.get("tools"):
        tool_tokens = estimate_tokens(json.dumps(body["tools"]))
        total_tokens += tool_tokens
    
    # Add overhead for message formatting (role tags, etc.) - approximately 4 tokens per message
    overhead = len(body.get("messages", [])) * 4
    if body.get("system"):
        overhead += 4  # System prompt overhead
    total_tokens += overhead
    
    print(f"\n=== Token Count ===")
    print(f"System: {system_tokens}, Messages: {message_tokens}, Tools: {tool_tokens}, Overhead: {overhead}")
    print(f"Total: {total_tokens}")
    
    return JSONResponse(content={"input_tokens": total_tokens})

@app.get("/health")
async def health(): 
    return JSONResponse(content={"status": "ok", "service": "a4f-anthropic-proxy"})

@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def catch_all(request: Request, path: str):
    print(f"\n=== UNHANDLED: {request.method} /{path} ===")
    return JSONResponse(status_code=404, content={"type": "error", "error": {"type": "not_found", "message": f"Endpoint {request.method} /{path} not found"}})

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
