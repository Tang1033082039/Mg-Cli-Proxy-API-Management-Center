import { normalizeApiBase } from './connection';

export const TOCODEX_DEFAULT_CHAT_PATH = '/v1/chat/completions';
export const TOCODEX_DEFAULT_RESPONSES_PATH = '/v1/responses';
export const TOCODEX_DEFAULT_RESPONSES_COMPACT_PATH = '/v1/responses/compact';
export const TOCODEX_DEFAULT_MODELS_PATH = '/v1/models';
export const TOCODEX_DEFAULT_TEST_PATH = TOCODEX_DEFAULT_RESPONSES_PATH;
export const TOCODEX_TEST_PATH_OPTIONS = [
  TOCODEX_DEFAULT_CHAT_PATH,
  TOCODEX_DEFAULT_RESPONSES_PATH,
] as const;

export type ToCodexRequestMode = 'chat' | 'responses';
export type ToCodexTestPath = (typeof TOCODEX_TEST_PATH_OPTIONS)[number];

const normalizeJoinedPath = (value: string, fallback: string): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;

  let path = raw;
  let query = '';
  const queryIndex = raw.indexOf('?');
  if (queryIndex >= 0) {
    path = raw.slice(0, queryIndex);
    query = raw.slice(queryIndex);
  }

  const normalizedPath = `/${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  return `${normalizedPath}${query}`;
};

const splitPathAndQuery = (value: string): { path: string; query: string } => {
  const queryIndex = value.indexOf('?');
  if (queryIndex < 0) {
    return { path: value, query: '' };
  }
  return {
    path: value.slice(0, queryIndex) || '/',
    query: value.slice(queryIndex + 1),
  };
};

const splitPathSegments = (value: string): string[] =>
  value
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

const resolveOverlapSize = (baseSegments: string[], requestSegments: string[]): number => {
  const maxSize = Math.min(baseSegments.length, requestSegments.length);
  for (let size = maxSize; size > 0; size -= 1) {
    let matched = true;
    for (let index = 0; index < size; index += 1) {
      if (baseSegments[baseSegments.length - size + index] !== requestSegments[index]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return size;
    }
  }
  return 0;
};

const joinToCodexPath = (basePath: string, requestPath: string): string => {
  const normalizedBasePath = normalizeJoinedPath(basePath || '/', '/');
  const normalizedRequestPath = normalizeJoinedPath(requestPath, '/');
  const baseSegments = splitPathSegments(normalizedBasePath);
  const requestSegments = splitPathSegments(normalizedRequestPath);

  if (requestSegments.length === 0) {
    return normalizedBasePath;
  }

  let mergedBaseSegments = baseSegments;
  let overlapSize = resolveOverlapSize(baseSegments, requestSegments);
  if (overlapSize === 0) {
    const firstSharedIndex = baseSegments.indexOf(requestSegments[0]);
    if (firstSharedIndex >= 0) {
      mergedBaseSegments = baseSegments.slice(0, firstSharedIndex + 1);
      overlapSize = resolveOverlapSize(mergedBaseSegments, requestSegments);
    }
  }

  const mergedSegments = [...mergedBaseSegments, ...requestSegments.slice(overlapSize)];
  return mergedSegments.length ? `/${mergedSegments.join('/')}` : '/';
};

export const normalizeToCodexRequestMode = (value: string | undefined): ToCodexRequestMode =>
  String(value ?? '').trim().toLowerCase() === 'chat' ? 'chat' : 'responses';

export const normalizeToCodexPath = (pathOrUrl: string | undefined, fallback: string): string => {
  const normalizedFallback = normalizeJoinedPath(fallback, '/');
  const raw = String(pathOrUrl ?? '').trim();
  if (!raw) return normalizedFallback;

  try {
    const parsed = new URL(raw);
    return normalizeJoinedPath(`${parsed.pathname}${parsed.search}`, normalizedFallback);
  } catch {
    return normalizeJoinedPath(raw, normalizedFallback);
  }
};

export const normalizeToCodexTestPath = (
  pathOrUrl: string | undefined,
  requestMode?: string
): ToCodexTestPath => {
  const fallback =
    normalizeToCodexRequestMode(requestMode) === 'chat'
      ? TOCODEX_DEFAULT_CHAT_PATH
      : TOCODEX_DEFAULT_RESPONSES_PATH;
  const normalizedPath = normalizeToCodexPath(pathOrUrl, fallback);
  const { path } = splitPathAndQuery(normalizedPath);
  if (path === TOCODEX_DEFAULT_CHAT_PATH) {
    return TOCODEX_DEFAULT_CHAT_PATH;
  }
  if (path === TOCODEX_DEFAULT_RESPONSES_PATH) {
    return TOCODEX_DEFAULT_RESPONSES_PATH;
  }
  return fallback;
};

export const resolveToCodexTestMode = (
  pathOrUrl: string | undefined,
  requestMode?: string
): ToCodexRequestMode =>
  normalizeToCodexTestPath(pathOrUrl, requestMode) === TOCODEX_DEFAULT_CHAT_PATH
    ? 'chat'
    : 'responses';

export const buildToCodexEndpoint = (
  baseUrl: string,
  pathOrUrl: string | undefined,
  fallback: string
): string => {
  const normalizedBase = normalizeApiBase(baseUrl);
  if (!normalizedBase) return '';

  const raw = String(pathOrUrl ?? '').trim();
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const normalizedPath = normalizeToCodexPath(pathOrUrl, fallback);
  try {
    const parsedBase = new URL(normalizedBase);
    const { path, query } = splitPathAndQuery(normalizedPath);
    parsedBase.pathname = joinToCodexPath(parsedBase.pathname, path);
    parsedBase.search = query ? `?${query}` : '';
    return parsedBase.toString();
  } catch {
    return `${normalizedBase.replace(/\/+$/g, '')}${normalizedPath}`;
  }
};

export const resolveToCodexSignaturePath = (
  endpointOrPath: string | undefined,
  fallback: string
): string => normalizeToCodexPath(endpointOrPath, fallback);

const encodeHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');

const createNonce = (): string => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const buildToCodexSignature = async (
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  secret: string
): Promise<string> => {
  const cryptoApi = globalThis.crypto?.subtle;
  if (!cryptoApi) {
    throw new Error('Current browser does not support Web Crypto');
  }

  const encoder = new TextEncoder();
  const raw = `${timestamp.trim()}:${nonce.trim()}:${method.trim().toUpperCase()}:${path.trim()}`;
  const key = await cryptoApi.importKey(
    'raw',
    encoder.encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await cryptoApi.sign('HMAC', key, encoder.encode(raw));
  return encodeHex(signature);
};

type ToCodexSignedHeaderOptions = {
  method: string;
  endpoint: string;
  apiKey: string;
  hmacSecret: string;
  customHeaders?: Record<string, string>;
  accept?: string;
  contentType?: string | null;
};

export const buildToCodexSignedHeaders = async ({
  method,
  endpoint,
  apiKey,
  hmacSecret,
  customHeaders,
  accept = 'application/json',
  contentType = undefined,
}: ToCodexSignedHeaderOptions): Promise<Record<string, string>> => {
  const trimmedApiKey = String(apiKey ?? '').trim();
  const trimmedSecret = String(hmacSecret ?? '').trim();
  if (!trimmedApiKey) {
    throw new Error('Missing ToCodex API key');
  }
  if (!trimmedSecret) {
    throw new Error('Missing ToCodex HMAC secret');
  }

  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const nonce = createNonce();
  const signaturePath = resolveToCodexSignaturePath(endpoint, '/');
  const signature = await buildToCodexSignature(
    timestamp,
    nonce,
    method,
    signaturePath,
    trimmedSecret
  );

  let host = '';
  try {
    host = new URL(endpoint).host;
  } catch {
    host = '';
  }

  const fixedHeaders: Record<string, string> = {
    Accept: accept,
    'Accept-Encoding': 'br, gzip, deflate',
    'Accept-Language': '*',
    Authorization: `Bearer ${trimmedApiKey}`,
    Connection: 'keep-alive',
    'HTTP-Referer': 'https://github.com/tocodex/ToCodex',
    'Sec-Fetch-Mode': 'cors',
    'User-Agent': 'ToCodex/3.1.3',
    'X-Title': 'ToCodex',
    'X-ToCodex-Timestamp': timestamp,
    'X-ToCodex-Nonce': nonce,
    'X-ToCodex-Sig': signature,
  };
  if (host) {
    fixedHeaders.Host = host;
  }

  const normalizedContentType =
    contentType === undefined ? (method.trim().toUpperCase() === 'GET' ? '' : 'application/json') : contentType;
  if (normalizedContentType) {
    fixedHeaders['Content-Type'] = normalizedContentType;
  }

  const fixedHeaderNames = new Set(Object.keys(fixedHeaders).map((key) => key.toLowerCase()));
  const sanitizedCustomHeaders = Object.entries(customHeaders ?? {}).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (fixedHeaderNames.has(key.toLowerCase())) {
        return acc;
      }
      acc[key] = value;
      return acc;
    },
    {}
  );

  return {
    ...sanitizedCustomHeaders,
    ...fixedHeaders,
  };
};
