import { invokeCommand } from '../native/commands';
import type { JsonValue } from '../native/types';
import { translate } from '../i18n';
import { CommandFailure, readCommandError } from './commandError';

export type ManagementJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

type ManagementRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: ManagementJson;
  timeoutMs?: number;
};

const normalizeQuery = (
  query?: Record<string, string | number | boolean | undefined>,
): Record<string, string> | undefined => {
  if (!query) {
    return undefined;
  }
  const normalized = Object.entries(query).reduce<Record<string, string>>((result, [key, value]) => {
    if (value !== undefined) {
      result[key] = String(value);
    }
    return result;
  }, {});
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

/** Fails with a `CommandFailure`: the core's status and own words, with the same sentence as before to show. */
async function request<T = ManagementJson>(
  method: string,
  path: string,
  options: ManagementRequestOptions = {},
): Promise<T> {
  try {
    // The core's JSON isn't typed on the Rust side, which passes it through; each caller says what it expects.
    return (await invokeCommand('management_request', {
      request: {
        method,
        path,
        query: normalizeQuery(options.query),
        body: options.body as JsonValue | undefined,
        timeoutMs: options.timeoutMs,
      },
    })) as T;
  } catch (reason) {
    throw new CommandFailure(readCommandError(reason));
  }
}

export const managementApi = {
  get: <T = ManagementJson>(path: string, query?: ManagementRequestOptions['query']) =>
    request<T>('GET', path, { query }),
  post: <T = ManagementJson>(
    path: string,
    body?: ManagementJson,
    options: Pick<ManagementRequestOptions, 'timeoutMs'> = {},
  ) => request<T>('POST', path, { ...options, body }),
  put: <T = ManagementJson>(path: string, body?: ManagementJson) =>
    request<T>('PUT', path, { body }),
  patch: <T = ManagementJson>(path: string, body?: ManagementJson) =>
    request<T>('PATCH', path, { body }),
  delete: <T = ManagementJson>(
    path: string,
    options: ManagementRequestOptions = {},
  ) => request<T>('DELETE', path, options),
  uploadAuthFile: async (file: File) => {
    const data = Array.from(new Uint8Array(await file.arrayBuffer()));
    return invokeCommand('upload_auth_file', {
      name: file.name,
      data,
    });
  },
  openAuthFilesDirectory: () => invokeCommand('open_auth_files_directory'),
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown, ...keys: string[]): string {
  if (!isRecord(value)) {
    return '';
  }
  for (const key of keys) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) {
      continue;
    }
    const text = String(candidate).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

export function readBoolean(value: unknown, ...keys: string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const key of keys) {
    if (typeof value[key] === 'boolean') {
      return value[key] as boolean;
    }
  }
  return false;
}

export function responseList(payload: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload[key])) {
    return [];
  }
  return payload[key].filter(isRecord);
}


export function normalizeAuthIndex(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

const messageFromPayload = (value: unknown, depth = 0): string => {
  if (value === null || value === undefined || depth > 3) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as unknown;
      const nested = messageFromPayload(parsed, depth + 1);
      if (nested) return nested;
    } catch {
      // The response is plain text rather than JSON.
    }
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = messageFromPayload(item, depth + 1);
      if (nested) return nested;
    }
    return '';
  }
  if (isRecord(value)) {
    for (const key of ['message', 'error', 'detail', 'error_description', 'title']) {
      const nested = messageFromPayload(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return '';
};

/** What an upstream answer says went wrong in its own words, or '' when it says nothing. */
export const apiCallWords = (response: Record<string, unknown>): string =>
  messageFromPayload(response.body ?? response.bodyText);

export function apiCallErrorMessage(
  response: Record<string, unknown>,
  fallback = translate('management.error.upstream'),
): string {
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  const message = messageFromPayload(response.body ?? response.bodyText);
  if (message) return message;
  return status > 0
    ? translate('management.error.upstreamHttp', { status })
    : fallback;
}
