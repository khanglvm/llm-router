/**
 * Strips request body fields the target model doesn't support.
 * Only acts when a capability is explicitly `false` — undefined means "pass through".
 *
 * @param {object} providerBody - Request body (already cloned upstream)
 * @param {object} [capabilities] - Model capabilities from config
 * @returns {object} The providerBody with unsupported fields deleted
 */
export function stripUnsupportedFields(providerBody, capabilities) {
  if (!capabilities || typeof capabilities !== "object") return providerBody;

  if (capabilities.supportsReasoning === false) {
    delete providerBody.reasoning_effort;
    delete providerBody.reasoning;
  }
  if (capabilities.supportsThinking === false) {
    delete providerBody.thinking;
  }
  if (capabilities.supportsResponseFormat === false) {
    delete providerBody.response_format;
  }
  if (capabilities.supportsLogprobs === false) {
    delete providerBody.logprobs;
    delete providerBody.top_logprobs;
  }
  if (capabilities.supportsServiceTier === false) {
    delete providerBody.service_tier;
  }
  if (capabilities.supportsPrediction === false) {
    delete providerBody.prediction;
    delete providerBody.predicted_output;
  }
  if (capabilities.supportsStreamOptions === false) {
    delete providerBody.stream_options;
  }

  return providerBody;
}

