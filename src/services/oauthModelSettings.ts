import { translate } from '../i18n';
import { invokeCommand } from '../native/commands';
import type { AuthFileExcludedModels } from '../native/types';
import { CommandFailure, readCommandError } from './commandError';
import { managementApi } from './managementApi';
import {
  normalizeOAuthExcludedRules,
  oauthExcludedRulesFromPayload,
  oauthModelCandidates,
  oauthModelsFromPayload,
  type OAuthModelDefinition,
} from './oauthModels';

export type OAuthModelTarget = { provider: string; label: string } & (
  | { scope: 'credential'; name: string }
  | { scope: 'provider' }
);

export type OAuthModelSettings = {
  target: OAuthModelTarget;
  models: OAuthModelDefinition[];
  excludedRules: string[];
  catalogError: string;
};

type OAuthModelSettingsApi = {
  get: (path: string, query?: Record<string, string>) => Promise<unknown>;
  patch: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  delete: (path: string, options?: { query?: Record<string, string> }) => Promise<unknown>;
  /** A credential file's own excluded models, read in Rust so the file's tokens stay out of the webview. */
  excludedModels: (name: string) => Promise<AuthFileExcludedModels>;
};

const oauthModelSettingsApi: OAuthModelSettingsApi = {
  get: managementApi.get,
  patch: managementApi.patch,
  delete: managementApi.delete,
  excludedModels: async (name) => {
    try {
      return await invokeCommand('get_auth_file_excluded_models', { name });
    } catch (reason) {
      throw new CommandFailure(readCommandError(reason));
    }
  },
};

/** A credential file's excluded models as rules, or a fixed message when the file can't be read for them. */
export const authFileExcludedRules = (read: AuthFileExcludedModels): string[] => {
  if (read.kind === 'invalidMetadata') throw new Error(translate('authFiles.models.invalidMetadata'));
  if (read.kind === 'invalidExclusions') throw new Error(translate('authFiles.models.invalidExclusions'));
  return normalizeOAuthExcludedRules(read.rules);
};

export const loadOAuthModelSettings = async (
  target: OAuthModelTarget,
  api: OAuthModelSettingsApi = oauthModelSettingsApi,
): Promise<OAuthModelSettings> => {
  const [catalog, excludedRules] = await Promise.all([
    (target.scope === 'credential'
      ? api.get('/auth-files/models', { name: target.name })
      : api.get(`/model-definitions/${encodeURIComponent(target.provider)}`))
      .then((definitions) => ({ models: oauthModelsFromPayload(definitions), error: '' }))
      .catch((error: unknown) => ({ models: [] as OAuthModelDefinition[], error: String(error) })),
    target.scope === 'credential'
      ? api.excludedModels(target.name).then(authFileExcludedRules)
      : api.get('/oauth-excluded-models').then((payload) => oauthExcludedRulesFromPayload(payload, target.provider)),
  ]);
  return {
    target,
    models: oauthModelCandidates(catalog.models, excludedRules),
    excludedRules,
    catalogError: catalog.error,
  };
};

/** Whether the rules as typed differ from the saved ones, ignoring order, case, blanks and repeats. */
export const oauthRulesChanged = (settings: OAuthModelSettings, rules: Iterable<string>): boolean => {
  const excludedModels = normalizeOAuthExcludedRules(rules);
  return excludedModels.length !== settings.excludedRules.length
    || !excludedModels.every((rule) => settings.excludedRules.includes(rule));
};

export const saveOAuthModelSettings = async (
  settings: OAuthModelSettings,
  rules: Iterable<string>,
  api: OAuthModelSettingsApi = oauthModelSettingsApi,
): Promise<void> => {
  const excludedModels = normalizeOAuthExcludedRules(rules);
  if (!oauthRulesChanged(settings, excludedModels)) return;
  if (settings.target.scope === 'credential') {
    // Patch only this field: never upload a stale copy of tokens or other metadata.
    await api.patch('/auth-files/fields', {
      name: settings.target.name,
      excluded_models: excludedModels,
    });
  } else if (excludedModels.length > 0) {
    await api.patch('/oauth-excluded-models', {
      provider: settings.target.provider,
      models: excludedModels,
    });
  } else if (settings.excludedRules.length > 0) {
    await api.delete('/oauth-excluded-models', { query: { provider: settings.target.provider } });
  }
};
