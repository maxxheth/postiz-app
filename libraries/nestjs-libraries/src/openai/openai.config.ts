import { Logger } from '@nestjs/common';

export interface OpenAiConfig {
  apiKey: string;
  baseURL?: string;
  imageModel: string;
  isGoogle: boolean;
  model: string;
}

const logger = new Logger('OpenAIConfig');
let cachedConfig: OpenAiConfig | null = null;

const resolveBaseUrl = (isGoogle: boolean) =>
  isGoogle
    ? process.env.OPENAI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai/'
    : process.env.OPENAI_BASE_URL;

const resolveModelName = (isGoogle: boolean) => {
  const primary = process.env.OPENAI_MODEL_NAME?.trim();
  if (primary) {
    return primary;
  }

  const fallback = process.env.OPENAI_FALLBACK_MODEL_NAME?.trim();
  if (fallback) {
    return fallback;
  }

  return isGoogle ? 'gemini-1.5-flash' : 'gpt-4o';
};

const resolveImageModelName = () => {
  const primary = process.env.OPENAI_IMAGE_MODEL_NAME?.trim();
  if (primary) {
    return primary;
  }

  return 'dall-e-3';
};

export const resolveOpenAiConfig = (): OpenAiConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const isGoogle = !!process.env.GOOGLE_AI_STUDIO_API_KEY;
  const model = resolveModelName(isGoogle);
  const imageModel = resolveImageModelName();
  const baseURL = resolveBaseUrl(isGoogle);
  const apiKey =
    process.env.GOOGLE_AI_STUDIO_API_KEY ||
    process.env.OPENAI_API_KEY ||
    'sk-proj-';

  cachedConfig = {
    apiKey,
    baseURL,
    imageModel,
    isGoogle,
    model,
  };

  logger.log(
    `Resolved OpenAI config: model=${model}, imageModel=${imageModel}, baseURL=${baseURL || 'default'}, google=${isGoogle}, modelEnv=${process.env.OPENAI_MODEL_NAME ? 'set' : 'unset'}`
  );

  return cachedConfig;
};
