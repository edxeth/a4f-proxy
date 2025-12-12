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

// Responses API Request
interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputMessage[];
  instructions?: string;
  tool_choice?: string | object;
  stream?: boolean;
  store?: boolean;
  previous_response_id?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: unknown[];
}

interface ResponsesInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[] | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

// Responses API Response
interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  output: ResponsesOutputItem[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

type ResponsesOutputItem = ResponsesReasoningItem | ResponsesMessageItem | ResponsesFunctionCallItem;

interface ResponsesReasoningItem {
  id: string;
  type: "reasoning";
  content: string[];
  summary: string[];
}

interface ResponsesMessageItem {
  id: string;
  type: "message";
  role: "assistant";
  status: "completed" | "in_progress";
  content: ResponsesOutputTextContent[];
}

interface ResponsesOutputTextContent {
  type: "output_text";
  text: string;
  annotations: unknown[];
  logprobs: unknown[];
}

// Function call output item for tool calls
interface ResponsesFunctionCallItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "completed" | "in_progress";
}

// ============================================================================
// Constants
// ============================================================================

const A4F_BASE_URL = "https://api.a4f.co/v1";
const A4F_PROVIDER_PREFIX = "provider-7";
const A4F_RESPONSES_PROVIDER_PREFIX = "provider-5";

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

    // Filter for GPT codex models only (they support the Responses API)
    // Matches: gpt-5-codex, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini, etc.
    // Non-codex models like gpt-4o, gpt-4.1 are excluded as they only support /v1/chat/completions
    const gptModels = a4fResponse.data
      .filter((model) => model.id.includes("codex"))
      .map((model) => ({
        id: model.id.replace(`${A4F_RESPONSES_PROVIDER_PREFIX}/`, ""),
        object: "model",
        created: model.created,
        owned_by: "openai",
      }));

    const models = {
      object: "list",
      data: [...claudeModels, ...gptModels],
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
// OpenAI Chat Completions Handler (Pass-through)
// ============================================================================

/**
 * Create an OpenAI-style error response
 */
function createOpenAIError(
  message: string,
  type: string,
  status: number
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    }),
    {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    }
  );
}

/**
 * Handle OpenAI-format /v1/chat/completions requests
 * Pass through to A4F backend without model name modification
 */
async function handleChatCompletions(
  request: Request,
  env: Env
): Promise<Response> {
  // Extract user's API key from request
  const userApiKey = extractApiKey(request);
  if (!userApiKey) {
    return createOpenAIError(
      "Missing API key. Please include an API key in the Authorization header.",
      "invalid_request_error",
      401
    );
  }

  // Validate user's API key against allowed keys
  if (!validateUserApiKey(userApiKey, env.VALID_API_KEYS)) {
    return createOpenAIError(
      "Invalid API key provided.",
      "invalid_request_error",
      401
    );
  }

  // Use the real A4F API key for forwarding requests
  const a4fApiKey = env.A4F_API_KEY;
  if (!a4fApiKey) {
    return createOpenAIError(
      "Server configuration error: A4F API key not configured",
      "server_error",
      500
    );
  }

  // Parse request body
  let body: OpenAIRequest;
  try {
    body = (await request.json()) as OpenAIRequest;
  } catch (e) {
    return createOpenAIError(
      e instanceof Error ? e.message : "Invalid JSON in request body",
      "invalid_request_error",
      400
    );
  }

  const isStreaming = body.stream === true;

  // Handle streaming requests
  if (isStreaming) {
    try {
      const response = await fetch(`${A4F_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${a4fApiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return createOpenAIError(
          errorText || `Upstream error: ${response.status}`,
          "api_error",
          response.status
        );
      }

      // Pass through the stream directly
      return new Response(response.body, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      return createOpenAIError(
        error instanceof Error ? error.message : String(error),
        "api_error",
        500
      );
    }
  }

  // Handle non-streaming requests
  try {
    const response = await fetch(`${A4F_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${a4fApiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return createOpenAIError(
        errorText || `Upstream error: ${response.status}`,
        "api_error",
        response.status
      );
    }

    const openaiResponse = await response.json();

    return new Response(JSON.stringify(openaiResponse), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    return createOpenAIError(
      error instanceof Error ? error.message : String(error),
      "api_error",
      500
    );
  }
}

// ============================================================================
// Responses API SSE Conversion
// ============================================================================

/**
 * Convert a non-streaming Responses API response to SSE format
 * This handles all output item types including function_call for tool use
 */
function convertResponsesToSSE(response: ResponsesResponse): Response {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      // Send response.created event
      const createdEvent = {
        type: "response.created",
        response: {
          id: response.id,
          object: "response",
          created_at: response.created_at,
          model: response.model,
          status: "in_progress",
          output: [],
          usage: null,
        },
      };
      controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify(createdEvent)}\n\n`));

      // Send response.in_progress event
      const inProgressEvent = {
        type: "response.in_progress",
        response: {
          id: response.id,
          object: "response",
          created_at: response.created_at,
          model: response.model,
          status: "in_progress",
          output: [],
          usage: null,
        },
      };
      controller.enqueue(encoder.encode(`event: response.in_progress\ndata: ${JSON.stringify(inProgressEvent)}\n\n`));

      // Process each output item
      for (let i = 0; i < response.output.length; i++) {
        const item = response.output[i];
        if (!item) continue;
        
        if (item.type === "reasoning") {
          // Send reasoning item events
          const reasoningItem = item as ResponsesReasoningItem;
          
          // Item created
          const itemCreatedEvent = {
            type: "response.output_item.added",
            output_index: i,
            item: {
              id: reasoningItem.id,
              type: "reasoning",
              status: "in_progress",
              content: [],
              summary: [],
            },
          };
          controller.enqueue(encoder.encode(`event: response.output_item.added\ndata: ${JSON.stringify(itemCreatedEvent)}\n\n`));

          // Send content
          for (let j = 0; j < reasoningItem.content.length; j++) {
            const contentDelta = {
              type: "response.reasoning_summary_part.added",
              item_id: reasoningItem.id,
              output_index: i,
              summary_index: j,
              part: { type: "summary_text", text: reasoningItem.summary[j] || "" },
            };
            controller.enqueue(encoder.encode(`event: response.reasoning_summary_part.added\ndata: ${JSON.stringify(contentDelta)}\n\n`));
          }

          // Item done
          const itemDoneEvent = {
            type: "response.output_item.done",
            output_index: i,
            item: reasoningItem,
          };
          controller.enqueue(encoder.encode(`event: response.output_item.done\ndata: ${JSON.stringify(itemDoneEvent)}\n\n`));
          
        } else if (item.type === "message") {
          // Send message item events
          const messageItem = item as ResponsesMessageItem;
          
          // Item created
          const itemCreatedEvent = {
            type: "response.output_item.added",
            output_index: i,
            item: {
              id: messageItem.id,
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          };
          controller.enqueue(encoder.encode(`event: response.output_item.added\ndata: ${JSON.stringify(itemCreatedEvent)}\n\n`));

          // Send content parts
          for (let j = 0; j < messageItem.content.length; j++) {
            const contentPart = messageItem.content[j];
            if (!contentPart) continue;
            
            // Content part added
            const contentAddedEvent = {
              type: "response.content_part.added",
              item_id: messageItem.id,
              output_index: i,
              content_index: j,
              part: { type: "output_text", text: "", annotations: [], logprobs: [] },
            };
            controller.enqueue(encoder.encode(`event: response.content_part.added\ndata: ${JSON.stringify(contentAddedEvent)}\n\n`));

            // Send text delta (send full text as one delta for simplicity)
            const textDeltaEvent = {
              type: "response.output_text.delta",
              item_id: messageItem.id,
              output_index: i,
              content_index: j,
              delta: contentPart.text,
            };
            controller.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify(textDeltaEvent)}\n\n`));

            // Text done event
            const textDoneEvent = {
              type: "response.output_text.done",
              item_id: messageItem.id,
              output_index: i,
              content_index: j,
              text: contentPart.text,
            };
            controller.enqueue(encoder.encode(`event: response.output_text.done\ndata: ${JSON.stringify(textDoneEvent)}\n\n`));

            // Content part done
            const contentDoneEvent = {
              type: "response.content_part.done",
              item_id: messageItem.id,
              output_index: i,
              content_index: j,
              part: contentPart,
            };
            controller.enqueue(encoder.encode(`event: response.content_part.done\ndata: ${JSON.stringify(contentDoneEvent)}\n\n`));
          }

          // Item done
          const itemDoneEvent = {
            type: "response.output_item.done",
            output_index: i,
            item: messageItem,
          };
          controller.enqueue(encoder.encode(`event: response.output_item.done\ndata: ${JSON.stringify(itemDoneEvent)}\n\n`));
          
        } else if (item.type === "function_call") {
          // Send function_call item events for tool calls
          const functionCallItem = item as ResponsesFunctionCallItem;
          
          // Item created
          const itemCreatedEvent = {
            type: "response.output_item.added",
            output_index: i,
            item: {
              id: functionCallItem.id,
              type: "function_call",
              call_id: functionCallItem.call_id,
              name: functionCallItem.name,
              arguments: "",
              status: "in_progress",
            },
          };
          controller.enqueue(encoder.encode(`event: response.output_item.added\ndata: ${JSON.stringify(itemCreatedEvent)}\n\n`));

          // Send function call arguments delta (send full arguments as one delta)
          const argsDeltaEvent = {
            type: "response.function_call_arguments.delta",
            item_id: functionCallItem.id,
            output_index: i,
            call_id: functionCallItem.call_id,
            delta: functionCallItem.arguments,
          };
          controller.enqueue(encoder.encode(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify(argsDeltaEvent)}\n\n`));

          // Send function call arguments done
          const argsDoneEvent = {
            type: "response.function_call_arguments.done",
            item_id: functionCallItem.id,
            output_index: i,
            call_id: functionCallItem.call_id,
            arguments: functionCallItem.arguments,
          };
          controller.enqueue(encoder.encode(`event: response.function_call_arguments.done\ndata: ${JSON.stringify(argsDoneEvent)}\n\n`));

          // Item done
          const itemDoneEvent = {
            type: "response.output_item.done",
            output_index: i,
            item: functionCallItem,
          };
          controller.enqueue(encoder.encode(`event: response.output_item.done\ndata: ${JSON.stringify(itemDoneEvent)}\n\n`));
        }
      }

      // Send response.completed event
      const completedEvent = {
        type: "response.completed",
        response: {
          id: response.id,
          object: "response",
          created_at: response.created_at,
          model: response.model,
          status: "completed",
          output: response.output,
          usage: response.usage,
        },
      };
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`));

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ============================================================================
// Responses API Handler
// ============================================================================

/**
 * Handle OpenAI-format /v1/responses requests
 * Forward to A4F backend with provider-5 prefix for model names
 *
 * IMPORTANT: This handler properly supports function_call output items
 * for tool use. The proxy does not strip tools from streaming requests.
 */
async function handleResponses(
  request: Request,
  env: Env
): Promise<Response> {
  // Extract user's API key from request
  const userApiKey = extractApiKey(request);
  if (!userApiKey) {
    return createOpenAIError(
      "Missing API key. Please include an API key in the Authorization header.",
      "invalid_request_error",
      401
    );
  }

  // Validate user's API key against allowed keys
  if (!validateUserApiKey(userApiKey, env.VALID_API_KEYS)) {
    return createOpenAIError(
      "Invalid API key provided.",
      "invalid_request_error",
      401
    );
  }

  // Use the real A4F API key for forwarding requests
  const a4fApiKey = env.A4F_API_KEY;
  if (!a4fApiKey) {
    return createOpenAIError(
      "Server configuration error: A4F API key not configured",
      "server_error",
      500
    );
  }

  // Parse request body
  let body: ResponsesRequest;
  try {
    body = (await request.json()) as ResponsesRequest;
  } catch (e) {
    return createOpenAIError(
      e instanceof Error ? e.message : "Invalid JSON in request body",
      "invalid_request_error",
      400
    );
  }

  const isStreaming = body.stream === true;

  // Add provider-5 prefix to model name
  // Strip reasoning.summary field as A4F streaming doesn't support it
  const reasoning = (body as unknown as Record<string, unknown>).reasoning as Record<string, unknown> | undefined;
  const modifiedReasoning = reasoning ? { effort: reasoning.effort } : undefined;
  
  const modifiedBody = {
    ...body,
    model: `${A4F_RESPONSES_PROVIDER_PREFIX}/${body.model}`,
    ...(modifiedReasoning && { reasoning: modifiedReasoning }),
  };

  // Handle streaming requests
  if (isStreaming) {
    try {
      const response = await fetch(`${A4F_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${a4fApiKey}`,
        },
        body: JSON.stringify(modifiedBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return createOpenAIError(
          errorText || `Upstream error: ${response.status}`,
          "api_error",
          response.status
        );
      }

      // Pass through the stream directly
      return new Response(response.body, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      return createOpenAIError(
        error instanceof Error ? error.message : String(error),
        "api_error",
        500
      );
    }
  }

  // Handle non-streaming requests
  try {
    const response = await fetch(`${A4F_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${a4fApiKey}`,
      },
      body: JSON.stringify(modifiedBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return createOpenAIError(
        errorText || `Upstream error: ${response.status}`,
        "api_error",
        response.status
      );
    }

    const a4fResponse = (await response.json()) as ResponsesResponse;

    // Strip provider-5 prefix from model name in response
    const modifiedResponse = {
      ...a4fResponse,
      model: a4fResponse.model.replace(`${A4F_RESPONSES_PROVIDER_PREFIX}/`, ""),
    };

    return new Response(JSON.stringify(modifiedResponse), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    return createOpenAIError(
      error instanceof Error ? error.message : String(error),
      "api_error",
      500
    );
  }
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
    let { pathname } = url;
    const method = request.method;

    // Normalize paths with various prefix issues (workaround for Roo Code subtask bugs)
    // Case 1: Double /v1 prefix - "node" client appends /v1/... to base URL that already has /v1
    if (pathname.startsWith("/v1/v1/")) {
      pathname = pathname.replace("/v1/v1/", "/v1/");
    }
    // Case 2: Double slash prefix - "node" client creates //v1/... path
    if (pathname.startsWith("//")) {
      pathname = pathname.replace(/^\/+/, "/");
    }

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return handleOptions();
    }

    // Route requests - support both /v1/* and /* paths for flexibility
    // This handles clients that use different base URL configurations
    if ((pathname === "/v1/messages" || pathname === "/messages") && method === "POST") {
      return handleMessages(request, env);
    }

    if ((pathname === "/v1/messages/count_tokens" || pathname === "/messages/count_tokens") && method === "POST") {
      return handleCountTokens(request);
    }

    if ((pathname === "/v1/chat/completions" || pathname === "/chat/completions") && method === "POST") {
      return handleChatCompletions(request, env);
    }

    if ((pathname === "/v1/responses" || pathname === "/responses") && method === "POST") {
      return handleResponses(request, env);
    }

    if (pathname === "/health" && method === "GET") {
      return handleHealth();
    }

    if ((pathname === "/v1/models" || pathname === "/models") && method === "GET") {
      return handleModels(env);
    }

    // Catch-all for unhandled routes
    return handleNotFound(request);
  },
};