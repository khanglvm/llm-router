/**
 * Translation Registry
 * Handles format conversion between Claude (Anthropic) and OpenAI formats
 */

import { FORMATS } from "./formats.js";
import { claudeToOpenAIRequest } from "./request/claude-to-openai.js";
import { openAIToClaudeRequest } from "./request/openai-to-claude.js";
import { openaiToClaudeResponse } from "./response/openai-to-claude.js";

/**
 * Translate request: source -> target
 */
export function translateRequest(sourceFormat, targetFormat, model, body, stream = true) {
  if (sourceFormat === targetFormat) {
    return body;
  }

  // Claude -> OpenAI
  if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.OPENAI) {
    return claudeToOpenAIRequest(model, body, stream);
  }

  // OpenAI -> Claude
  if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.CLAUDE) {
    return openAIToClaudeRequest(model, body, stream);
  }

  return body;
}

/**
 * Translate response chunk: target -> source
 */
export function translateResponse(targetFormat, sourceFormat, chunk, state) {
  if (sourceFormat === targetFormat) {
    return [chunk];
  }

  // OpenAI -> Claude
  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.CLAUDE) {
    const result = openaiToClaudeResponse(chunk, state);
    return result || [];
  }

  return [chunk];
}

/**
 * Initialize state for streaming response
 */
export function initState(sourceFormat) {
  return {
    messageId: null,
    model: null,
    textBlockStarted: false,
    thinkingBlockStarted: false,
    textBlockIndex: 0,
    thinkingBlockIndex: null,
    nextBlockIndex: 0,
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
    messageStartSent: false,
    textBlockClosed: false
  };
}

export function needsTranslation(sourceFormat, targetFormat) {
  return sourceFormat !== targetFormat;
}

export { FORMATS };
