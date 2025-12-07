// Devkit Anthropic Proxy - Cloudflare Worker
// Converts Anthropic v1/messages API to OpenAI-compatible API

import { fromPreTrained } from "@lenml/tokenizer-claude";

// ============================================================================
// Tokenizer Singleton
// ============================================================================

let tokenizer: ReturnType<typeof fromPreTrained> | null = null;

function getTokenizer(): ReturnType<typeof fromPreTrained> {
  if (!tokenizer) {
    tokenizer = fromPreTrained();
  }
  return tokenizer;
}

// ============================================================================
// Types
// ============================================================================

interface Env {
  A4F_API_KEY: string;      // Your real A4F API key (secret)
  VALID_API_KEYS: string;   // Comma-separated list of keys you give to users
}

// Anthropic Types
interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicToolChoice {
  type: "auto" | "any" | "none" | "tool";
  name?: string;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: {
    user_id?: string;
  };
}

// OpenAI Types
interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream: boolean;
  stream_options?: {
    include_usage: boolean;
  };
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: OpenAITool[];
  tool_choice?: string | { type: "function"; function: { name: string } };
  user?: string;
}

interface OpenAIChoice {
  index: number;
  message?: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason: string | null;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

const A4F_BASE_URL = "https://api.a4f.co/v1";
const A4F_PROVIDER_PREFIX = "provider-7";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, x-api-key, Authorization, anthropic-version",
};

// ============================================================================
// Utility Functions
// ============================================================================

function generateMessageId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "msg_";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateCallId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "call_";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Count tokens using the Claude tokenizer
 * Uses @lenml/tokenizer-claude for accurate token counting
 */
function countTokens(text: string): number {
  const tok = getTokenizer();
  const encoded = tok.encode(text, { add_special_tokens: false });
  return encoded.length;
}

function contentToString(
  content: string | AnthropicContentBlock[]
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractApiKey(request: Request): string | null {
  // Check x-api-key header (Anthropic style)
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) return xApiKey;

  // Check Authorization header (OpenAI style)
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Validate user API key against the list of valid keys
 */
function validateUserApiKey(userKey: string, validKeysString: string): boolean {
  if (!validKeysString) return false;
  const validKeys = validKeysString.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
  return validKeys.includes(userKey);
}

function validateModel(model: string): { valid: boolean; error?: string } {
  if (!model.includes("claude")) {
    return {
      valid: false,
      error: `Model "${model}" is not a Claude model. Only Claude models are supported.`,
    };
  }
  return { valid: true };
}

// ============================================================================
// Request Conversion (Anthropic → OpenAI)
// ============================================================================

function convertMessages(
  messages: AnthropicMessage[],
  system?: string | AnthropicTextBlock[]
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // Add system message if present
  if (system) {
    const systemText =
      typeof system === "string"
        ? system
        : system
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    result.push({ role: "system", content: systemText });
  }

  for (const msg of messages) {
    const { role, content } = msg;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    // Handle content blocks
    const toolUseBlocks = content.filter(
      (b): b is AnthropicToolUseBlock => b.type === "tool_use"
    );
    const toolResultBlocks = content.filter(
      (b): b is AnthropicToolResultBlock => b.type === "tool_result"
    );
    const textBlocks = content.filter(
      (b): b is AnthropicTextBlock => b.type === "text"
    );
    const imageBlocks = content.filter(
      (b): b is AnthropicImageBlock => b.type === "image"
    );

    if (toolUseBlocks.length > 0 && role === "assistant") {
      // Assistant message with tool calls
      const toolCalls: OpenAIToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id || generateCallId(),
        type: "function" as const,
        function: {
          name: b.name || "",
          arguments: JSON.stringify(b.input || {}),
        },
      }));

      const textContent = textBlocks.map((b) => b.text).join("") || null;
      result.push({
        role: "assistant",
        content: textContent,
        tool_calls: toolCalls,
      });
    } else if (toolResultBlocks.length > 0) {
      // Tool result messages
      for (const b of toolResultBlocks) {
        const resultContent =
          typeof b.content === "string"
            ? b.content
            : contentToString(b.content);
        result.push({
          role: "tool",
          content: resultContent,
          tool_call_id: b.tool_use_id || "",
        });
      }
    } else if (imageBlocks.length > 0 || textBlocks.length > 0) {
      // Mixed content (text and/or images)
      const parts: OpenAIContentPart[] = [];

      for (const block of content) {
        if (block.type === "text" && block.text) {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image" && block.source) {
          const { media_type, data } = block.source;
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${media_type || "image/png"};base64,${data || ""}`,
            },
          });
        }
      }

      // Simplify if only one text part
      const firstPart = parts[0];
      if (parts.length === 1 && firstPart && firstPart.type === "text" && firstPart.text) {
        result.push({ role, content: firstPart.text });
      } else {
        result.push({ role, content: parts });
      }
    }
  }

  return result;
}

function convertTools(tools?: AnthropicTool[]): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || {},
    },
  }));
}

function convertToolChoice(
  choice?: AnthropicToolChoice
): string | { type: "function"; function: { name: string } } | undefined {
  if (!choice) return undefined;

  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return {
        type: "function",
        function: { name: choice.name || "" },
      };
    default:
      return "auto";
  }
}

function convertRequest(req: AnthropicRequest): OpenAIRequest {
  const openaiReq: OpenAIRequest = {
    model: `${A4F_PROVIDER_PREFIX}/${req.model}`,
    messages: convertMessages(req.messages, req.system),
    max_tokens: req.max_tokens,
    stream: req.stream || false,
  };

  if (req.stream) {
    openaiReq.stream_options = { include_usage: true };
  }

  if (req.temperature !== undefined) {
    openaiReq.temperature = req.temperature;
  }

  if (req.top_p !== undefined) {
    openaiReq.top_p = req.top_p;
  }

  if (req.stop_sequences) {
    openaiReq.stop = req.stop_sequences;
  }

  if (req.tools) {
    openaiReq.tools = convertTools(req.tools);
  }

  if (req.tool_choice) {
    openaiReq.tool_choice = convertToolChoice(req.tool_choice);
  }

  if (req.metadata?.user_id) {
    openaiReq.user = req.metadata.user_id;
  }

  return openaiReq;
}

// ============================================================================
// Response Conversion (OpenAI → Anthropic)
// ============================================================================

function mapFinishReason(
  finishReason: string | null
): "end_turn" | "max_tokens" | "tool_use" {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

function convertResponse(
  res: OpenAIResponse,
  model: string,
  inputTokens: number
): Record<string, unknown> {
  const choice = res.choices?.[0];
  const message = choice?.message;
  const content: Array<Record<string, unknown>> = [];

  // Accumulate output text for local token counting
  let outputText = "";

  if (message?.content) {
    content.push({ type: "text", text: message.content });
    outputText += message.content;
  }

  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      let input: Record<string, unknown> = {};
      const argsStr = tc.function?.arguments || "{}";
      try {
        input = JSON.parse(argsStr);
      } catch {
        // Keep empty object on parse failure
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input,
      });
      // Include tool call arguments in token count
      outputText += argsStr;
    }
  }

  // Count output tokens locally using our Claude tokenizer
  const outputTokens = countTokens(outputText);

  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: mapFinishReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

// ============================================================================
// Token Estimation
// ============================================================================

function estimateRequestTokens(openaiReq: OpenAIRequest): number {
  let total = 0;

  for (const msg of openaiReq.messages) {
    if (typeof msg.content === "string") {
      total += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          total += countTokens(part.text);
        }
      }
    }
    // No overhead added - count raw tokens only for accuracy
  }

  // Add tool definitions if present
  if (openaiReq.tools) {
    total += countTokens(JSON.stringify(openaiReq.tools));
  }

  return total;
}

// ============================================================================
// Streaming Handler
// ============================================================================

async function streamAndConvert(
  apiKey: string,
  openaiReq: OpenAIRequest,
  model: string
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const msgId = generateMessageId();
  const estimatedInputTokens = estimateRequestTokens(openaiReq);

  let accumulatedText = ""; // Accumulate all output text for token counting
  let contentIndex = 0;
  let textStarted = false;
  let toolStarted = false;
  let stopReason: "end_turn" | "max_tokens" | "tool_use" = "end_turn";

  return new ReadableStream({
    async start(controller) {
      // Send message_start event
      const messageStart = {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: estimatedInputTokens,
            output_tokens: 1,
          },
        },
      };
      controller.enqueue(
        encoder.encode(
          `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`
        )
      );

      try {
        const response = await fetch(`${A4F_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(openaiReq),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          const errorEvent = {
            type: "error",
            error: {
              type: "api_error",
              message: errorBody,
            },
          };
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`
            )
          );
          controller.close();
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const chunk: OpenAIStreamChunk = JSON.parse(data);
              const choice = chunk.choices?.[0];
              const delta = choice?.delta;

              // Note: We no longer use A4F's token count - we count locally

              // Track finish reason
              if (choice?.finish_reason) {
                stopReason = mapFinishReason(choice.finish_reason);
              }

              // Handle text content
              if (delta?.content) {
                if (!textStarted) {
                  textStarted = true;
                  const blockStart = {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: {
                      type: "text",
                      text: "",
                    },
                  };
                  controller.enqueue(
                    encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`
                    )
                  );
                }

                // Accumulate text for local token counting
                accumulatedText += delta.content;

                const blockDelta = {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: {
                    type: "text_delta",
                    text: delta.content,
                  },
                };
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`
                  )
                );
              }

              // Handle tool calls
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.id) {
                    // New tool call starting
                    if (textStarted) {
                      const blockStop = {
                        type: "content_block_stop",
                        index: contentIndex,
                      };
                      controller.enqueue(
                        encoder.encode(
                          `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`
                        )
                      );
                      contentIndex++;
                      textStarted = false;
                    }

                    if (toolStarted) {
                      const blockStop = {
                        type: "content_block_stop",
                        index: contentIndex,
                      };
                      controller.enqueue(
                        encoder.encode(
                          `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`
                        )
                      );
                      contentIndex++;
                    }

                    toolStarted = true;
                    const toolStart = {
                      type: "content_block_start",
                      index: contentIndex,
                      content_block: {
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function?.name || "",
                        input: {},
                      },
                    };
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(toolStart)}\n\n`
                      )
                    );
                  }

                  if (tc.function?.arguments) {
                    // Accumulate tool arguments for token counting
                    accumulatedText += tc.function.arguments;

                    const toolDelta = {
                      type: "content_block_delta",
                      index: contentIndex,
                      delta: {
                        type: "input_json_delta",
                        partial_json: tc.function.arguments,
                      },
                    };
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(toolDelta)}\n\n`
                      )
                    );
                  }
                }
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        // Close content blocks
        if (textStarted || toolStarted) {
          const blockStop = {
            type: "content_block_stop",
            index: contentIndex,
          };
          controller.enqueue(
            encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`
            )
          );
        }

        // Count output tokens locally using our Claude tokenizer
        const outputTokens = countTokens(accumulatedText);

        // Send message_delta with final usage
        const messageDelta = {
          type: "message_delta",
          delta: {
            stop_reason: stopReason,
            stop_sequence: null,
          },
          usage: {
            output_tokens: outputTokens,
          },
        };
        controller.enqueue(
          encoder.encode(
            `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`
          )
        );

        // Send message_stop
        const messageStop = { type: "message_stop" };
        controller.enqueue(
          encoder.encode(
            `event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`
          )
        );

        controller.close();
      } catch (error) {
        const errorEvent = {
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`
          )
        );
        controller.close();
      }
    },
  });
}

// ============================================================================
// Request Handlers
// ============================================================================

async function handleMessages(request: Request, env: Env): Promise<Response> {
  // Extract user's API key from request
  const userApiKey = extractApiKey(request);
  if (!userApiKey) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Missing API key",
        },
      }),
      {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // Validate user's API key against allowed keys
  if (!validateUserApiKey(userApiKey, env.VALID_API_KEYS)) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      }),
      {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // Use the real A4F API key for forwarding requests
  const a4fApiKey = env.A4F_API_KEY;
  if (!a4fApiKey) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: "Server configuration error: A4F API key not configured",
        },
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // Parse request body
  let body: AnthropicRequest;
  try {
    body = (await request.json()) as AnthropicRequest;
  } catch (e) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: e instanceof Error ? e.message : "Invalid JSON",
        },
      }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // Validate model
  const validation = validateModel(body.model || "");
  if (!validation.valid) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: validation.error,
        },
      }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // Convert request
  const openaiReq = convertRequest(body);

  // Handle streaming
  if (body.stream) {
    const stream = await streamAndConvert(a4fApiKey, openaiReq, body.model);
    return new Response(stream, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // Handle non-streaming
  try {
    const response = await fetch(`${A4F_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${a4fApiKey}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: errorText,
          },
        }),
        {
          status: response.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }

    const openaiResponse = (await response.json()) as OpenAIResponse;
    // Calculate input tokens locally for consistency
    const inputTokens = estimateRequestTokens(openaiReq);
    const anthropicResponse = convertResponse(openaiResponse, body.model, inputTokens);

    return new Response(JSON.stringify(anthropicResponse), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
}

async function handleCountTokens(request: Request): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await request.json()) as AnthropicRequest;
  } catch (e) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: e instanceof Error ? e.message : "Invalid JSON",
        },
      }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  let totalTokens = 0;

  // Count system prompt tokens
  if (body.system) {
    if (typeof body.system === "string") {
      totalTokens += countTokens(body.system);
    } else {
      for (const block of body.system) {
        if (block.type === "text" && block.text) {
          totalTokens += countTokens(block.text);
        }
      }
    }
  }

  // Count message tokens
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      totalTokens += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && "text" in block) {
          totalTokens += countTokens(block.text);
        }
      }
    }
  }

  // Count tool definitions tokens
  if (body.tools) {
    totalTokens += countTokens(JSON.stringify(body.tools));
  }

  // No overhead added - count raw tokens only for accuracy

  return new Response(JSON.stringify({ input_tokens: totalTokens }), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function handleHealth(): Response {
  return new Response(
    JSON.stringify({ status: "ok", service: "devkit-anthropic-proxy" }),
    {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    }
  );
}

interface A4FModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface A4FModelsResponse {
  object: string;
  data: A4FModel[];
}

async function handleModels(env: Env): Promise<Response> {
  try {
    // Fetch models from A4F API
    const response = await fetch(`${A4F_BASE_URL}/models?plan=ultra`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.A4F_API_KEY}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `Failed to fetch models from A4F: ${errorText}`,
          },
        }),
        {
          status: response.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }

    const a4fResponse = (await response.json()) as A4FModelsResponse;

    // Filter for Claude models (provider-7/claude*) and strip the prefix
    const claudeModels = a4fResponse.data
      .filter((model) => model.id.startsWith(`${A4F_PROVIDER_PREFIX}/claude`))
      .map((model) => ({
        id: model.id.replace(`${A4F_PROVIDER_PREFIX}/`, ""),
        object: "model",
        created: model.created,
        owned_by: "anthropic",
      }));

    const models = {
      object: "list",
      data: claudeModels,
    };

    return new Response(JSON.stringify(models), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: `Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`,
        },
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

function handleNotFound(request: Request): Response {
  const url = new URL(request.url);
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "not_found",
        message: `Endpoint ${request.method} ${url.pathname} not found`,
      },
    }),
    {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    }
  );
}

// ============================================================================
// Main Handler
// ============================================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return handleOptions();
    }

    // Route requests
    if (pathname === "/v1/messages" && method === "POST") {
      return handleMessages(request, env);
    }

    if (pathname === "/v1/messages/count_tokens" && method === "POST") {
      return handleCountTokens(request);
    }

    if (pathname === "/health" && method === "GET") {
      return handleHealth();
    }

    if (pathname === "/v1/models" && method === "GET") {
      return handleModels(env);
    }

    // Catch-all for unhandled routes
    return handleNotFound(request);
  },
};