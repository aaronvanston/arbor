import { FormEvent, useEffect, useRef, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertCircle, Check, Copy, ExternalLink, Eye, EyeOff, FolderOpen, KeyRound, Pause, Pencil, Play, Plus, Sparkles, Trash2 } from '../components/ui/icons';
import { useCoreRuntime } from '../coreRuntime';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { InlineNotice, useAppNotice } from '../appNotice';
import { webUiManagementUrl } from '../services/clientAccess';
import { clientKeyName, maskApiKey, newClientKey } from '../services/clientKeys';
import { proxyUrlProblem, sessionTtlProblem } from '../services/coreSettingsInput';
import { useUnsavedChanges } from '../services/unsavedChanges';
import { plainError } from '../services/plainError';
import { CORE_CONFIG_DEFAULTS as CORE, changedFromDefaults, onOffLabel, resetOffer } from '../services/settingDefaults';
import { confirmSettingsInEffect, notLoadedNotice } from '../services/settingsInEffect';
import { useConfirmation } from '../components/ConfirmationDialog';
import { ThinkingAliasesPage } from './ThinkingAliasesPage';
import { QuitGuardSettings } from './QuitGuardSettings';
import { SoftwareSettingsSection } from './SoftwareSettings';
import { CommandLineSettings } from './CommandLineSettings';
import { UsageDataSettings } from './UsageDataSettings';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { FoldedSettingsSection, SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { AlertDialog, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { draftFromNumber, NumberField, numberFromDraft } from '../components/ui/number-field';
import { Label } from '../components/ui/label';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { toast } from '../components/ui/toast';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import type { CoreApiKeyView, CoreConfigView, CoreTlsSettings } from '../native/types';
import { AccountOrderSection } from './AccountRouting';

type ConfigAction =
  | 'add-key'
  | 'update-key'
  | 'delete-key'
  | 'resume-key'
  | 'delete-paused-key'
  | 'management-secret'
  | 'logging'
  | 'open-logs'
  | 'routing'
  | 'network'
  | 'retry'
  | 'tls'
  | null;
type ConfigSubpage = 'general' | 'routing' | 'software' | 'aliases';
type NetworkDraftField =
  | 'port'
  | 'host'
  | 'proxyUrl'
  | 'sessionAffinity'
  | 'sessionTtl'
  | 'disableCooling'
  | 'requestRetry'
  | 'maxRetryCredentials'
  | 'maxRetryInterval'
  | 'streamingBootstrapRetries';
type DraftRefreshMode = 'replace' | 'preserve';

type NetworkDraftDirty = Record<NetworkDraftField, boolean>;

const cleanNetworkDraft = (): NetworkDraftDirty => ({
  port: false,
  host: false,
  proxyUrl: false,
  sessionAffinity: false,
  sessionTtl: false,
  disableCooling: false,
  requestRetry: false,
  maxRetryCredentials: false,
  maxRetryInterval: false,
  streamingBootstrapRetries: false,
});

const ROUTING_OPTIONS = [
  { value: 'round-robin', labelKey: 'config.routing.roundRobin' },
  { value: 'fill-first', labelKey: 'config.routing.fillFirst' },
] as const;

export type { ConfigSubpage };

export function ConfigPanelPage({ section }: { section: ConfigSubpage }) {
  const { t } = useI18n();
  // A save that worked says so in a toast; one that failed stays in the section's own notice.
  const saved = (key: MessageKey) => toast({ kind: 'success', title: t(key) });
  // Settings the proxy takes without a restart are only called saved once it's running them: one value it can't read
  // anywhere in config.yaml makes it keep its old settings, which the section's notice then says.
  const savedLive = async (key: MessageKey, feedback: ReturnType<typeof useAppNotice>) => {
    const notice = notLoadedNotice(await confirmSettingsInEffect());
    if (notice) feedback.showNotice(notice, 'error');
    else saved(key);
  };
  // How a default reads in the tooltip of the button that puts it back.
  const onOff = onOffLabel(t);
  const withUnit = (value: number, unit: string) => t('settings.reset.withUnit', { value, unit });
  const { status: coreStatus, publishStatus, refreshStatus } = useCoreRuntime();
  const [settings, setSettings] = useState<CoreConfigView | null>(null);
  const [tlsSettings, setTlsSettings] = useState<CoreTlsSettings | null>(null);
  const [tlsSettingsLoading, setTlsSettingsLoading] = useState(true);
  const [tlsEnabledDraft, setTlsEnabledDraft] = useState(false);
  const [tlsCertDraft, setTlsCertDraft] = useState('');
  const [tlsKeyDraft, setTlsKeyDraft] = useState('');
  const [tlsError, setTlsError] = useState('');
  const [tlsFileSelecting, setTlsFileSelecting] = useState<'cert' | 'key' | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyAction, setBusyAction] = useState<ConfigAction>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [newApiKey, setNewApiKey] = useState('');
  const [newApiKeyRemark, setNewApiKeyRemark] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [formError, setFormError] = useState('');
  const [managementSecretDraft, setManagementSecretDraft] = useState('');
  const [managementSecretConfirm, setManagementSecretConfirm] = useState('');
  const [showManagementSecret, setShowManagementSecret] = useState(false);
  const [managementSecretError, setManagementSecretError] = useState('');
  const [debugDraft, setDebugDraft] = useState(false);
  const [commercialModeDraft, setCommercialModeDraft] = useState(false);
  const [loggingToFileDraft, setLoggingToFileDraft] = useState(false);
  const [logsMaxTotalSizeDraft, setLogsMaxTotalSizeDraft] = useState('0');
  const [errorLogsMaxFilesDraft, setErrorLogsMaxFilesDraft] = useState('10');
  const [usageStatisticsDraft, setUsageStatisticsDraft] = useState(true);
  const [redisUsageRetentionDraft, setRedisUsageRetentionDraft] = useState('60');
  const [loggingError, setLoggingError] = useState('');
  const { copy, copied } = useCopyToClipboard({ inline: true });
  const keyFeedback = useAppNotice();
  const { askConfirmation } = useConfirmation();
  const managementFeedback = useAppNotice();
  const loggingFeedback = useAppNotice();
  const networkFeedback = useAppNotice();
  const routingFeedback = useAppNotice();
  const retryFeedback = useAppNotice();
  const renderFeedback = (feedback: ReturnType<typeof useAppNotice>) => (
    <InlineNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
  );
  const activeSubpage = section;
  const [portDraft, setPortDraft] = useState('8317');
  const [hostDraft, setHostDraft] = useState('127.0.0.1');
  const [proxyUrlDraft, setProxyUrlDraft] = useState('');
  const [sessionAffinityDraft, setSessionAffinityDraft] = useState(false);
  const [sessionTtlDraft, setSessionTtlDraft] = useState('');
  const [disableCoolingDraft, setDisableCoolingDraft] = useState(false);
  const [requestRetryDraft, setRequestRetryDraft] = useState('3');
  const [maxRetryCredentialsDraft, setMaxRetryCredentialsDraft] = useState('0');
  const [maxRetryIntervalDraft, setMaxRetryIntervalDraft] = useState('30');
  const [streamingBootstrapRetriesDraft, setStreamingBootstrapRetriesDraft] = useState('0');
  const [portError, setPortError] = useState('');
  const [hostError, setHostError] = useState('');
  const [retryError, setRetryError] = useState('');
  const networkDraftDirtyRef = useRef<NetworkDraftDirty>(cleanNetworkDraft());
  const loggingDraftDirtyRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void loadSettings();
    void loadTlsSettings();
    void listen('config-files-changed', () => {
      if (!disposed) {
        void loadSettings('preserve');
        void loadTlsSettings();
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
    // Mount-only: the first loads and the config listener are set up once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySettings = (result: CoreConfigView, mode: DraftRefreshMode = 'replace') => {
    setSettings(result);
    if (mode === 'preserve') {
      const dirty = networkDraftDirtyRef.current;
      if (!dirty.port) setPortDraft(String(result.port));
      if (!dirty.host) setHostDraft(result.host);
      if (!dirty.proxyUrl) setProxyUrlDraft(result.proxyUrl);
      if (!dirty.sessionAffinity) setSessionAffinityDraft(result.routingSessionAffinity);
      if (!dirty.sessionTtl) setSessionTtlDraft(result.routingSessionAffinityTtl);
      if (!dirty.disableCooling) setDisableCoolingDraft(result.disableCooling);
      if (!dirty.requestRetry) setRequestRetryDraft(String(result.requestRetry));
      if (!dirty.maxRetryCredentials) setMaxRetryCredentialsDraft(String(result.maxRetryCredentials));
      if (!dirty.maxRetryInterval) setMaxRetryIntervalDraft(String(result.maxRetryInterval));
      if (!dirty.streamingBootstrapRetries) {
        setStreamingBootstrapRetriesDraft(String(result.streamingBootstrapRetries));
      }
      if (!loggingDraftDirtyRef.current) {
        setDebugDraft(result.debug);
        setCommercialModeDraft(result.commercialMode);
        setLoggingToFileDraft(result.loggingToFile);
        setLogsMaxTotalSizeDraft(String(result.logsMaxTotalSizeMb));
        setErrorLogsMaxFilesDraft(String(result.errorLogsMaxFiles));
        setUsageStatisticsDraft(result.usageStatisticsEnabled);
        setRedisUsageRetentionDraft(String(result.redisUsageQueueRetentionSeconds));
      }
      return;
    }
    networkDraftDirtyRef.current = cleanNetworkDraft();
    loggingDraftDirtyRef.current = false;
    setPortDraft(String(result.port));
    setHostDraft(result.host);
    setProxyUrlDraft(result.proxyUrl);
    setSessionAffinityDraft(result.routingSessionAffinity);
    setSessionTtlDraft(result.routingSessionAffinityTtl);
    setDisableCoolingDraft(result.disableCooling);
    setRequestRetryDraft(String(result.requestRetry));
    setMaxRetryCredentialsDraft(String(result.maxRetryCredentials));
    setMaxRetryIntervalDraft(String(result.maxRetryInterval));
    setStreamingBootstrapRetriesDraft(String(result.streamingBootstrapRetries));
    setDebugDraft(result.debug);
    setCommercialModeDraft(result.commercialMode);
    setLoggingToFileDraft(result.loggingToFile);
    setLogsMaxTotalSizeDraft(String(result.logsMaxTotalSizeMb));
    setErrorLogsMaxFilesDraft(String(result.errorLogsMaxFiles));
    setUsageStatisticsDraft(result.usageStatisticsEnabled);
    setRedisUsageRetentionDraft(String(result.redisUsageQueueRetentionSeconds));
    setPortError('');
    setHostError('');
    setRetryError('');
    setLoggingError('');
  };

  const markLoggingDraftDirty = () => {
    loggingDraftDirtyRef.current = true;
    setLoggingError('');
  };

  const markDraftDirty = (field: NetworkDraftField) => {
    networkDraftDirtyRef.current[field] = true;
  };

  const clearDraftDirty = (field: NetworkDraftField) => {
    networkDraftDirtyRef.current[field] = false;
  };

  async function loadSettings(mode: DraftRefreshMode = 'replace') {
    setLoading(true);
    setLoadError('');
    try {
      const result = await invokeCommand('get_core_config_settings');
      applySettings(result, mode);
    } catch (error) {
      setSettings(null);
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadTlsSettings() {
    setTlsSettingsLoading(true);
    try {
      const result = await invokeCommand('get_core_tls_settings');
      setTlsSettings(result);
      setTlsEnabledDraft(result.enabled);
      setTlsCertDraft(result.cert);
      setTlsKeyDraft(result.key);
      setTlsError('');
    } catch (error) {
      setTlsSettings(null);
      setTlsError(String(error));
    } finally {
      setTlsSettingsLoading(false);
    }
  }

  const runMutation = async (
    action: Exclude<ConfigAction, null>,
    mutate: () => Promise<CoreConfigView>,
    successMessage: string,
  ) => {
    setBusyAction(action);
    const mutationFeedback = action === 'management-secret'
      ? managementFeedback
      : action === 'routing' ? routingFeedback : keyFeedback;
    mutationFeedback.clearNotice();
    try {
      const result = await mutate();
      setSettings(result);
      setLoadError('');
      // A paused key lives only in Arbor's file. The management key isn't checked for: asking the core while it's still
      // swapping the key in counts as a refused key, and five of those lock Arbor out for half an hour.
      const checked = action !== 'management-secret' && action !== 'delete-paused-key';
      const notice = checked ? notLoadedNotice(await confirmSettingsInEffect()) : null;
      if (notice) mutationFeedback.showNotice(notice, 'error');
      else if (action !== 'routing') toast({ kind: 'success', title: successMessage });
      return true;
    } catch (error) {
      if (settings) setSettings(settings);
      mutationFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: plainError(error, t) } }, 'error');
      void loadSettings('preserve');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const openAddDialog = () => {
    keyFeedback.clearNotice();
    setEditingApiKey(null);
    setNewApiKey('');
    setNewApiKeyRemark('');
    setShowApiKey(false);
    setFormError('');
    setAddDialogOpen(true);
  };

  const openEditDialog = (entry: CoreApiKeyView) => {
    keyFeedback.clearNotice();
    setEditingApiKey(entry.apiKey);
    setNewApiKey(entry.apiKey);
    setNewApiKeyRemark(entry.remark);
    setShowApiKey(false);
    setFormError('');
    setAddDialogOpen(true);
  };

  const closeAddDialog = () => {
    if (busyAction === 'add-key' || busyAction === 'update-key') {
      return;
    }
    setAddDialogOpen(false);
    setEditingApiKey(null);
    setFormError('');
  };

  const generateApiKey = () => {
    setNewApiKey(newClientKey());
    setShowApiKey(true);
    setFormError('');
  };

  const generateManagementSecret = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const secret = `webui-${value}`;
    setManagementSecretDraft(secret);
    setManagementSecretConfirm(secret);
    setShowManagementSecret(true);
    setManagementSecretError('');
  };

  const saveManagementSecret = async (event: FormEvent) => {
    event.preventDefault();
    const secretKey = managementSecretDraft.trim();
    if (!secretKey) {
      setManagementSecretError(t('config.webuiKey.error.empty'));
      return;
    }
    if (secretKey === '123456') {
      setManagementSecretError(t('config.webuiKey.error.legacyDefault'));
      return;
    }
    if (secretKey.length > 512) {
      setManagementSecretError(t('config.webuiKey.error.tooLong'));
      return;
    }
    // Matching control characters is the point: a key can't contain them.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f]/.test(secretKey)) {
      setManagementSecretError(t('config.webuiKey.error.invalid'));
      return;
    }
    if (secretKey !== managementSecretConfirm.trim()) {
      setManagementSecretError(t('config.webuiKey.error.mismatch'));
      return;
    }

    const saved = await runMutation(
      'management-secret',
      () => invokeCommand('set_core_management_secret_key', { secretKey }),
      t('config.webuiKey.notice.updated'),
    );
    if (saved) {
      setManagementSecretDraft('');
      setManagementSecretConfirm('');
      setShowManagementSecret(false);
      setManagementSecretError('');
    }
  };

  const submitApiKey = async (event: FormEvent) => {
    event.preventDefault();
    const apiKey = newApiKey.trim();
    if (!apiKey) {
      setFormError(t('config.error.emptyKey'));
      return;
    }
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      setFormError(t('config.error.invalidKey'));
      return;
    }
    if (settings?.apiKeys.some((entry) => entry.apiKey === apiKey && entry.apiKey !== editingApiKey)) {
      setFormError(t('config.error.duplicateKey'));
      return;
    }
    const remark = newApiKeyRemark.trim();
    if (remark.length > 80) {
      setFormError(t('config.error.remarkTooLong'));
      return;
    }

    const editing = editingApiKey !== null;
    const saved = await runMutation(
      editing ? 'update-key' : 'add-key',
      () => editing
        ? invokeCommand('update_core_api_key', { originalApiKey: editingApiKey, apiKey, remark })
        : invokeCommand('add_core_api_key', { apiKey, remark }),
      editing ? t('config.notice.keyUpdated') : t('config.notice.keyAdded'),
    );
    if (saved) {
      setAddDialogOpen(false);
      setEditingApiKey(null);
      setNewApiKey('');
      setNewApiKeyRemark('');
    }
  };

  const saveCoreLoggingSettings = async () => {
    if (!settings || busyAction !== null) return;
    loggingFeedback.clearNotice();
    const logsMaxTotalSizeMb = Number(logsMaxTotalSizeDraft);
    const errorLogsMaxFiles = Number(errorLogsMaxFilesDraft);
    const redisUsageQueueRetentionSeconds = Number(redisUsageRetentionDraft);
    if (
      !Number.isInteger(logsMaxTotalSizeMb)
      || logsMaxTotalSizeMb < 0
      || logsMaxTotalSizeMb > 4294967295
      || !Number.isInteger(errorLogsMaxFiles)
      || errorLogsMaxFiles < 0
      || errorLogsMaxFiles > 4294967295
    ) {
      const message = t('config.diagnostics.error.nonNegativeInteger');
      setLoggingError(message);
      return;
    }
    if (
      !Number.isInteger(redisUsageQueueRetentionSeconds)
      || redisUsageQueueRetentionSeconds < 1
      || redisUsageQueueRetentionSeconds > 3600
    ) {
      const message = t('config.diagnostics.error.redisRetention');
      setLoggingError(message);
      return;
    }

    const commercialModeChanged = commercialModeDraft !== settings.commercialMode;
    setBusyAction('logging');
    setLoggingError('');
    try {
      const result = await invokeCommand('save_core_logging_settings', {
        settings: {
          debug: debugDraft,
          commercialMode: commercialModeDraft,
          loggingToFile: loggingToFileDraft,
          logsMaxTotalSizeMb,
          errorLogsMaxFiles,
          usageStatisticsEnabled: usageStatisticsDraft,
          redisUsageQueueRetentionSeconds,
        },
      });
      loggingDraftDirtyRef.current = false;
      applySettings(result, 'preserve');
      if (commercialModeChanged && coreStatus?.running) {
        const status = await invokeCommand('restart_core_process');
        publishStatus(status);
        saved('config.diagnostics.notice.savedAndRestarted');
      } else {
        await savedLive('config.diagnostics.notice.saved', loggingFeedback);
      }
    } catch (error) {
      const message = t('config.error.saveFailed', { error: plainError(error, t) });
      setLoggingError(message);
      void refreshStatus();
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const openCoreLogsDirectory = async () => {
    if (busyAction !== null) return;
    setBusyAction('open-logs');
    try {
      await invokeCommand('open_core_logs_directory');
    } catch (error) {
      loggingFeedback.showNotice({ key: 'config.diagnostics.error.openLogs', variables: { error: plainError(error, t) } }, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const confirmDelete = async () => {
    if (deleteIndex === null) {
      return;
    }
    const deleted = await runMutation(
      'delete-key',
      () => invokeCommand('delete_core_api_key', { apiKey: selectedDeleteKey }),
      t('config.notice.keyDeleted'),
    );
    if (deleted) {
      setDeleteIndex(null);
    }
  };

  const resumePausedKey = (entry: CoreApiKeyView) => {
    void runMutation('resume-key', () => invokeCommand('resume_core_api_key', { apiKeyHash: entry.apiKeyHash }), t('config.notice.keyResumed'));
  };

  const deletePausedKey = async (entry: CoreApiKeyView) => {
    const confirmed = await askConfirmation({
      title: t('config.keys.deletePausedTitle'),
      message: t('config.keys.deletePausedMessage', { key: clientKeyName(entry) }),
      details: [{ label: t('config.keys.label'), value: maskApiKey(entry.apiKey) }],
      confirmText: t('common.delete'),
      variant: 'danger',
    });
    if (confirmed) {
      await runMutation('delete-paused-key', () => invokeCommand('delete_paused_core_api_key', { apiKeyHash: entry.apiKeyHash }), t('config.notice.keyDeleted'));
    }
  };

  const openWebUi = async () => {
    try {
      const [latestSettings, latestTlsSettings] = await Promise.all([
        invokeCommand('get_core_config_settings'),
        invokeCommand('get_core_tls_settings'),
      ]);
      applySettings(latestSettings, 'preserve');
      setTlsSettings(latestTlsSettings);
      setTlsEnabledDraft(latestTlsSettings.enabled);
      setTlsCertDraft(latestTlsSettings.cert);
      setTlsKeyDraft(latestTlsSettings.key);
      await invokeCommand('open_external_url', {
        url: webUiManagementUrl(latestSettings.port, latestTlsSettings.enabled, latestSettings.host),
      });
    } catch (error) {
      managementFeedback.showNotice({ key: 'config.webuiKey.error.openFailed', variables: { error: plainError(error, t) } }, 'error');
    }
  };

  const saveTlsSettings = async () => {
    if (tlsSettings === null || busyAction !== null) return;
    const cert = tlsCertDraft.trim();
    const key = tlsKeyDraft.trim();
    if (tlsEnabledDraft && (!cert || !key)) {
      setTlsError(t('config.tls.error.pathsRequired'));
      return;
    }

    setBusyAction('tls');
    setTlsError('');
    try {
      const result = await invokeCommand('save_core_tls_settings', {
        settings: { enabled: tlsEnabledDraft, cert, key },
      });
      setTlsSettings(result);
      setTlsEnabledDraft(result.enabled);
      setTlsCertDraft(result.cert);
      setTlsKeyDraft(result.key);
      if (coreStatus?.running) {
        const status = await invokeCommand('restart_core_process');
        publishStatus(status);
        saved('config.tls.notice.savedAndRestarted');
      } else {
        saved('config.tls.notice.saved');
      }
    } catch (error) {
      setTlsError(String(error));
      void refreshStatus();
      void loadTlsSettings();
    } finally {
      setBusyAction(null);
    }
  };

  const selectTlsFile = async (target: 'cert' | 'key') => {
    if (tlsSettings === null || busyAction !== null || tlsFileSelecting !== null) return;
    setTlsFileSelecting(target);
    setTlsError('');
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: target === 'cert'
          ? t('config.tls.selectCertTitle')
          : t('config.tls.selectKeyTitle'),
        filters: [{
          name: target === 'cert' ? t('config.tls.certFile') : t('config.tls.keyFile'),
          extensions: target === 'cert' ? ['pem', 'crt', 'cer'] : ['pem', 'key'],
        }],
      });
      if (typeof selected !== 'string') return;
      if (target === 'cert') setTlsCertDraft(selected);
      else setTlsKeyDraft(selected);
    } catch (error) {
      const message = t('config.tls.error.selectFileFailed', { error: String(error) });
      setTlsError(message);
    } finally {
      setTlsFileSelecting(null);
    }
  };

  const changeRoutingStrategy = async (strategy: string) => {
    if (strategy === settings?.routingStrategy) {
      return;
    }
    await runMutation(
      'routing',
      () => invokeCommand('set_core_routing_strategy', { strategy }),
      t('config.notice.routingUpdated'),
    );
  };

  const saveNetworkEndpointSettings = async () => {
    networkFeedback.clearNotice();
    if (!settings || busyAction !== null) return;
    const host = hostDraft.trim();
    if (!host) {
      setHostError(t('config.error.hostRequired'));
      networkFeedback.showNotice({ key: 'config.error.hostRequired' }, 'error');
      return;
    }
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError(t('config.error.portRange'));
      networkFeedback.showNotice({ key: 'config.error.portRange' }, 'error');
      return;
    }

    const proxyUrl = proxyUrlDraft.trim();
    if (proxyUrlProblem(proxyUrl)) return;
    const networkChanged = port !== settings.port || host !== settings.host;
    setHostError('');
    setPortError('');
    setBusyAction('network');
    try {
      const result = await invokeCommand('save_network_endpoint_settings', {
        settings: { host, port, proxyUrl },
      });
      clearDraftDirty('host');
      clearDraftDirty('port');
      clearDraftDirty('proxyUrl');
      applySettings(result, 'preserve');
      setLoadError('');

      if (networkChanged && coreStatus?.running) {
        try {
          const status = await invokeCommand('restart_core_process');
          publishStatus(status);
          saved('config.notice.networkRestarted');
        } catch (error) {
          await refreshStatus();
          networkFeedback.showNotice({ key: 'config.error.networkRestartFailed', variables: { error: plainError(error, t) } }, 'error');
        }
      } else if (networkChanged) {
        saved('config.notice.networkNextStart');
      } else {
        await savedLive('config.notice.networkUpdated', networkFeedback);
      }
    } catch (error) {
      networkFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: plainError(error, t) } }, 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const saveRetrySettings = async () => {
    retryFeedback.clearNotice();
    if (!settings || busyAction !== null) return;
    const retryDrafts = [
      requestRetryDraft,
      maxRetryCredentialsDraft,
      maxRetryIntervalDraft,
      streamingBootstrapRetriesDraft,
    ];
    const retryValues = retryDrafts.map(Number);
    if (
      retryDrafts.some((value) => value.length === 0)
      || retryValues.some((value) => !Number.isInteger(value) || value < 0 || value > 4294967295)
    ) {
      setRetryError(t('config.error.retryRange'));
      retryFeedback.showNotice({ key: 'config.error.retryRange' }, 'error');
      return;
    }
    setRetryError('');
    setBusyAction('retry');
    try {
      const result = await invokeCommand('save_retry_settings', {
        settings: {
          disableCooling: disableCoolingDraft,
          requestRetry: Number(requestRetryDraft),
          maxRetryCredentials: Number(maxRetryCredentialsDraft),
          maxRetryInterval: Number(maxRetryIntervalDraft),
          streamingBootstrapRetries: Number(streamingBootstrapRetriesDraft),
        },
      });
      clearDraftDirty('disableCooling');
      clearDraftDirty('requestRetry');
      clearDraftDirty('maxRetryCredentials');
      clearDraftDirty('maxRetryInterval');
      clearDraftDirty('streamingBootstrapRetries');
      applySettings(result, 'preserve');
      setLoadError('');
      await savedLive('config.notice.retryUpdated', retryFeedback);
    } catch (error) {
      retryFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: plainError(error, t) } }, 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const saveSessionRoutingSettings = async () => {
    routingFeedback.clearNotice();
    if (!settings || busyAction !== null) return;
    const routingSessionAffinityTtl = sessionTtlDraft.trim();
    if (sessionTtlProblem(routingSessionAffinityTtl)) return;
    setBusyAction('routing');
    try {
      const result = await invokeCommand('save_session_routing_settings', {
        settings: {
          routingSessionAffinity: sessionAffinityDraft,
          routingSessionAffinityTtl,
        },
      });
      clearDraftDirty('sessionAffinity');
      clearDraftDirty('sessionTtl');
      applySettings(result, 'preserve');
      setLoadError('');
      await savedLive('config.notice.sessionRoutingUpdated', routingFeedback);
    } catch (error) {
      routingFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: plainError(error, t) } }, 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const controlsDisabled = loading || settings === null || busyAction !== null;
  // Shown as they're typed, and kept from being saved.
  const proxyUrlError = proxyUrlProblem(proxyUrlDraft);
  const sessionTtlError = sessionTtlProblem(sessionTtlDraft);
  const networkSettingsDirty = Boolean(settings) && (
    hostDraft.trim() !== settings?.host
    || portDraft !== String(settings?.port)
    || proxyUrlDraft.trim() !== settings?.proxyUrl
  );
  const sessionRoutingDirty = Boolean(settings) && (
    sessionAffinityDraft !== settings?.routingSessionAffinity
    || sessionTtlDraft.trim() !== settings?.routingSessionAffinityTtl
  );
  const retrySettingsDirty = Boolean(settings) && (
    disableCoolingDraft !== settings?.disableCooling
    || requestRetryDraft !== String(settings?.requestRetry)
    || maxRetryCredentialsDraft !== String(settings?.maxRetryCredentials)
    || maxRetryIntervalDraft !== String(settings?.maxRetryInterval)
    || streamingBootstrapRetriesDraft !== String(settings?.streamingBootstrapRetries)
  );
  const loggingSettingsDirty = Boolean(settings) && (
    debugDraft !== settings?.debug
    || commercialModeDraft !== settings?.commercialMode
    || loggingToFileDraft !== settings?.loggingToFile
    || logsMaxTotalSizeDraft !== String(settings?.logsMaxTotalSizeMb)
    || errorLogsMaxFilesDraft !== String(settings?.errorLogsMaxFiles)
    || usageStatisticsDraft !== settings?.usageStatisticsEnabled
    || redisUsageRetentionDraft !== String(settings?.redisUsageQueueRetentionSeconds)
  );
  const tlsSettingsDirty = tlsSettings !== null && (
    tlsEnabledDraft !== tlsSettings.enabled
    || tlsCertDraft.trim() !== tlsSettings.cert
    || tlsKeyDraft.trim() !== tlsSettings.key
  );
  useUnsavedChanges(
    networkSettingsDirty || sessionRoutingDirty || retrySettingsDirty || loggingSettingsDirty
    || tlsSettingsDirty || managementSecretDraft.trim() !== '',
  );
  // What a folded group says it holds that isn't at its default, as the fields stand (saved or not).
  const loggingChanged = changedFromDefaults([
    [debugDraft, CORE.debug], [commercialModeDraft, CORE.commercialMode], [loggingToFileDraft, CORE.loggingToFile],
    [logsMaxTotalSizeDraft, CORE.logsMaxTotalSizeMb], [errorLogsMaxFilesDraft, CORE.errorLogsMaxFiles],
    [redisUsageRetentionDraft, CORE.redisUsageQueueRetentionSeconds],
  ]);
  const retryChanged = changedFromDefaults([
    [disableCoolingDraft, CORE.disableCooling], [requestRetryDraft, CORE.requestRetry], [maxRetryCredentialsDraft, CORE.maxRetryCredentials],
    [maxRetryIntervalDraft, CORE.maxRetryInterval], [streamingBootstrapRetriesDraft, CORE.streamingBootstrapRetries],
  ]);
  const tlsChanged = changedFromDefaults([[tlsEnabledDraft, CORE.tlsEnabled]]);
  const tlsStatusLabel = tlsSettingsLoading
    ? t('common.loading')
    : tlsSettings === null
      ? t('common.unavailable')
      : tlsSettingsDirty
        ? t('config.network.unsaved')
        : '';
  const selectedDeleteKey =
    deleteIndex === null ? '' : settings?.apiKeys[deleteIndex]?.apiKey || '';
  const deletingLastKey = deleteIndex !== null && settings?.apiKeys.length === 1;
  const keyMutationBusy = busyAction === 'add-key' || busyAction === 'update-key';
  const managementSecretBusy = busyAction === 'management-secret';
  const loggingSettingsBusy = busyAction === 'logging';

  const feedbackBlock = (feedback: ReturnType<typeof useAppNotice>) => (
    feedback.notice ? <SettingsBlock>{renderFeedback(feedback)}</SettingsBlock> : null
  );
  const tlsControlsDisabled = tlsSettingsLoading || tlsSettings === null || busyAction !== null;
  const tlsFieldsDisabled = tlsControlsDisabled || tlsFileSelecting !== null;
  const sectionLabel: Record<ConfigSubpage, MessageKey> = {
    general: 'config.tabs.general',
    routing: 'config.tabs.routing',
    aliases: 'app.nav.thinkingAliases',
    software: 'config.tabs.software',
  };

  const saveButton = (label: string, busy: boolean, disabled: boolean, onClick: () => void) => (
    <Button size="sm" disabled={disabled} onClick={onClick}>
      {busy ? <Spinner /> : <Check />}
      {busy ? t('common.saving') : label}
    </Button>
  );

  const numericInput = (
    value: string,
    onChange: (next: string) => void,
    onReset: () => void,
    options: { maxLength: number; invalid?: boolean; ariaLabel: string; min: number; max: number; unit?: string },
  ) => (
    <NumberField
      min={options.min}
      max={options.max}
      maxLength={options.maxLength}
      value={numberFromDraft(value)}
      disabled={controlsDisabled}
      aria-invalid={options.invalid || undefined}
      aria-label={options.ariaLabel}
      unit={options.unit}
      wrapperClassName="w-28"
      font="mono"
      className="text-right"
      onValueChange={(next) => onChange(draftFromNumber(next))}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && settings) {
          onReset();
          event.currentTarget.blur();
        }
      }}
    />
  );

  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t(sectionLabel[activeSubpage])]} />
      </PageTopbar>

      {activeSubpage === 'general' ? (
        <PageBody>
          <SettingsSection
            settingId="general.api-keys"
            title={t('config.keys.title')}
            headerAction={
              <div className="flex items-center gap-2">
                <Badge variant="muted" aria-label={t('config.keys.count')}>{settings?.apiKeys.length ?? 0}</Badge>
                <Button variant="outline" size="sm" onClick={openAddDialog} disabled={controlsDisabled}>
                  <Plus />
                  {t('common.add')}
                </Button>
              </div>
            }
          >
            {loading ? (
              Array.from({ length: 3 }, (_, index) => (
                <SettingsBlock key={index} className="flex items-center gap-3" aria-hidden="true">
                  <Skeleton className="h-4 w-6" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </SettingsBlock>
              ))
            ) : loadError ? (
              <SettingsBlock>
                <Alert
                  variant="error"
                  icon={<AlertCircle />}
                  action={
                    <Button variant="outline" size="xs" onClick={() => void loadSettings()}>
                      <RefreshIcon />
                      {t('common.retry')}
                    </Button>
                  }
                >
                  <div className="font-medium">{t('config.unavailable')}</div>
                  <AlertDescription><span title={loadError}>{loadError}</span></AlertDescription>
                </Alert>
              </SettingsBlock>
            ) : settings && settings.apiKeys.length > 0 ? (
              settings.apiKeys.map((entry, index) => (
                <SettingsBlock key={`${index}-${entry.apiKey}`} className="flex min-h-12 items-center gap-3 py-2">
                  <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground" title={entry.remark || t('config.keys.noRemark')}>
                      {entry.remark || <span className="font-normal text-muted-foreground">{t('config.keys.noRemark')}</span>}
                    </div>
                    <code className="block truncate font-mono text-xs text-muted-foreground" title={maskApiKey(entry.apiKey)}>{maskApiKey(entry.apiKey)}</code>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost-muted"
                            size="icon-sm"
                            onClick={() => void copy(entry.apiKey, { id: `key:${index}` })}
                            disabled={controlsDisabled}
                            focusableWhenDisabled
                            aria-label={copied === `key:${index}` ? t('config.notice.keyCopied') : t('config.keys.copyNth', { number: index + 1 })}
                          />
                        }
                      >
                        {copied === `key:${index}` ? <Check className="text-success" /> : <Copy />}
                      </TooltipTrigger>
                      <TooltipPopup>{copied === `key:${index}` ? t('config.notice.keyCopied') : t('config.keys.copy')}</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="ghost-muted" size="icon-sm" onClick={() => openEditDialog(entry)} disabled={controlsDisabled} focusableWhenDisabled aria-label={t('config.keys.editNth', { number: index + 1 })} />
                        }
                      >
                        <Pencil />
                      </TooltipTrigger>
                      <TooltipPopup>{t('config.keys.edit')}</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost-muted"
                            size="icon-sm"
                            className="hover:text-error"
                            onClick={() => setDeleteIndex(index)}
                            disabled={controlsDisabled}
                            focusableWhenDisabled
                            aria-label={t('config.keys.deleteNth', { number: index + 1 })}
                          />
                        }
                      >
                        <Trash2 />
                      </TooltipTrigger>
                      <TooltipPopup>{t('config.keys.delete')}</TooltipPopup>
                    </Tooltip>
                  </div>
                </SettingsBlock>
              ))
            ) : (
              <Empty size="sm">
                <EmptyMedia><KeyRound /></EmptyMedia>
                <EmptyTitle>{t('config.keys.empty')}</EmptyTitle>
                <EmptyDescription>{t('config.keys.add')}</EmptyDescription>
              </Empty>
            )}
            {settings?.pausedApiKeys?.map((entry) => (
              <SettingsBlock key={`paused-${entry.apiKeyHash}`} className="flex min-h-12 items-center gap-3 py-2">
                <span className="flex w-6 shrink-0 justify-center text-warning" aria-hidden="true"><Pause className="size-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-muted-foreground" title={entry.remark || t('config.keys.noRemark')}>
                      {entry.remark || <span className="font-normal">{t('config.keys.noRemark')}</span>}
                    </span>
                    <Tooltip>
                      <TooltipTrigger render={<Badge variant="warning" className="shrink-0" />}>{t('config.keys.paused')}</TooltipTrigger>
                      <TooltipPopup>{t('config.keys.pausedHint')}</TooltipPopup>
                    </Tooltip>
                  </div>
                  <code className="block truncate font-mono text-xs text-muted-foreground" title={maskApiKey(entry.apiKey)}>{maskApiKey(entry.apiKey)}</code>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button variant="outline" size="xs" onClick={() => resumePausedKey(entry)} disabled={controlsDisabled}>
                    {busyAction === 'resume-key' ? <Spinner /> : <Play />}
                    {t('config.keys.resume')}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost-muted"
                          size="icon-sm"
                          className="hover:text-error"
                          onClick={() => void deletePausedKey(entry)}
                          disabled={controlsDisabled}
                          focusableWhenDisabled
                          aria-label={t('config.keys.deletePausedNamed', { key: clientKeyName(entry) })}
                        />
                      }
                    >
                      <Trash2 />
                    </TooltipTrigger>
                    <TooltipPopup>{t('config.keys.deletePausedTitle')}</TooltipPopup>
                  </Tooltip>
                </div>
              </SettingsBlock>
            ))}
            {!addDialogOpen && deleteIndex === null ? feedbackBlock(keyFeedback) : null}
          </SettingsSection>

          <SettingsSection
            title={t('config.network.networkSection')}
            headerAction={saveButton(t('config.network.save'), busyAction === 'network', controlsDisabled || !networkSettingsDirty || Boolean(proxyUrlError), () => void saveNetworkEndpointSettings())}
          >
            <SettingsRow
              settingId="general.port"
              reset={resetOffer(portDraft, CORE.port, String(CORE.port), () => { markDraftDirty('port'); setPortDraft(String(CORE.port)); setPortError(''); }, controlsDisabled)}
              title={t('config.network.port')}
              description={t('config.network.portHint')}
              status={portError ? <span className="text-error-foreground">{portError}</span> : null}
              control={numericInput(portDraft, (next) => { markDraftDirty('port'); setPortDraft(next); setPortError(''); }, () => { clearDraftDirty('port'); setPortDraft(String(settings?.port ?? '')); setPortError(''); }, { maxLength: 5, invalid: Boolean(portError), ariaLabel: t('config.network.port'), min: 1, max: 65535 })}
            />
            <SettingsRow
              settingId="general.host"
              reset={resetOffer(hostDraft, CORE.host, CORE.host, () => { markDraftDirty('host'); setHostDraft(CORE.host); setHostError(''); }, controlsDisabled)}
              title={t('config.network.listenHost')}
              description={t('config.network.listenHostHint')}
              status={hostError ? <span className="text-error-foreground">{hostError}</span> : null}
              control={
                <Input
                  type="text"
                  value={hostDraft}
                  disabled={controlsDisabled}
                  placeholder="127.0.0.1"
                  aria-invalid={Boolean(hostError) || undefined}
                  aria-label={t('config.network.listenHost')}
                  wrapperClassName="w-56"
                  font="mono"
                  onChange={(event) => { markDraftDirty('host'); setHostDraft(event.currentTarget.value); setHostError(''); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('host');
                      setHostDraft(settings.host);
                      setHostError('');
                      event.currentTarget.blur();
                    }
                  }}
                />
              }
            />
            <SettingsRow
              settingId="general.proxy-url"
              reset={resetOffer(proxyUrlDraft, CORE.proxyUrl, t('settings.reset.none'), () => { markDraftDirty('proxyUrl'); setProxyUrlDraft(CORE.proxyUrl); }, controlsDisabled)}
              title={t('config.network.proxyUrl')}
              description={t('config.network.proxyHint')}
              status={proxyUrlError ? <span className="text-error-foreground">{t(proxyUrlError)}</span> : null}
              control={
                <Input
                  type="text"
                  value={proxyUrlDraft}
                  aria-invalid={Boolean(proxyUrlError) || undefined}
                  disabled={controlsDisabled}
                  placeholder={t('config.network.proxyPlaceholder')}
                  aria-label={t('config.network.proxyUrl')}
                  wrapperClassName="w-72"
                  font="mono"
                  onChange={(event) => { markDraftDirty('proxyUrl'); setProxyUrlDraft(event.currentTarget.value); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('proxyUrl');
                      setProxyUrlDraft(settings.proxyUrl);
                      event.currentTarget.blur();
                    }
                  }}
                />
              }
            />
            {feedbackBlock(networkFeedback)}
          </SettingsSection>

          <SettingsSection
            title={t('config.webuiKey.title')}
            description={t('config.webuiKey.description')}
            headerAction={
              <Button
                variant="outline"
                size="sm"
                disabled={loading || settings === null}
                focusableWhenDisabled
                onClick={() => void openWebUi()}
                title={settings ? webUiManagementUrl(settings.port, tlsSettings?.enabled, settings.host) : undefined}
              >
                <ExternalLink />
                {t('config.webuiKey.open')}
              </Button>
            }
          >
            <form onSubmit={(event) => void saveManagementSecret(event)}>
              <SettingsRow
                settingId="general.webui-key"
                title={t('config.webuiKey.heading')}
                description={t('config.webuiKey.securityHint')}
                align="start"
                control={
                  <div className="flex w-72 flex-col gap-2">
                    <Input
                      type={showManagementSecret ? 'text' : 'password'}
                      autoComplete="new-password"
                      maxLength={512}
                      value={managementSecretDraft}
                      disabled={controlsDisabled}
                      aria-invalid={Boolean(managementSecretError) || undefined}
                      aria-label={t('config.webuiKey.newKey')}
                      placeholder={t('config.webuiKey.placeholder')}
                      onChange={(event) => {
                        setManagementSecretDraft(event.currentTarget.value);
                        setManagementSecretError('');
                      }}
                      endAddon={
                        <Button
                          type="button"
                          variant="ghost-muted"
                          size="icon-xs"
                          disabled={controlsDisabled}
                          onClick={() => setShowManagementSecret((value) => !value)}
                          aria-label={showManagementSecret ? t('config.keys.hide') : t('config.keys.show')}
                        >
                          {showManagementSecret ? <EyeOff /> : <Eye />}
                        </Button>
                      }
                    />
                    <Input
                      type={showManagementSecret ? 'text' : 'password'}
                      autoComplete="new-password"
                      maxLength={512}
                      value={managementSecretConfirm}
                      disabled={controlsDisabled}
                      aria-invalid={Boolean(managementSecretError) || undefined}
                      aria-label={t('config.webuiKey.confirmKey')}
                      placeholder={t('config.webuiKey.confirmPlaceholder')}
                      onChange={(event) => {
                        setManagementSecretConfirm(event.currentTarget.value);
                        setManagementSecretError('');
                      }}
                    />
                  </div>
                }
              />
              {managementSecretError ? (
                <SettingsBlock className="pt-0">
                  <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{managementSecretError}</AlertDescription></Alert>
                </SettingsBlock>
              ) : null}
              <SettingsBlock className="flex items-center justify-end gap-2 bg-muted/40 py-2.5 dark:bg-input/10">
                <Button type="button" variant="ghost-muted" size="sm" disabled={controlsDisabled} onClick={generateManagementSecret}>
                  <Sparkles />
                  {t('config.webuiKey.generate')}
                </Button>
                <Button type="submit" size="sm" disabled={controlsDisabled || !managementSecretDraft.trim()}>
                  {managementSecretBusy ? <Spinner /> : <Check />}
                  {managementSecretBusy ? t('common.saving') : t('config.webuiKey.save')}
                </Button>
              </SettingsBlock>
            </form>
            {feedbackBlock(managementFeedback)}
          </SettingsSection>

          <FoldedSettingsSection
            fold="retry"
            title={t('config.network.retrySection')}
            changed={retryChanged}
            attention={Boolean(retryFeedback.notice || retryError)}
            headerAction={saveButton(t('config.network.save'), busyAction === 'retry', controlsDisabled || !retrySettingsDirty, () => void saveRetrySettings())}
          >
            <SettingsRow
              settingId="general.disable-cooling"
              reset={resetOffer(disableCoolingDraft, CORE.disableCooling, onOff(CORE.disableCooling), () => { markDraftDirty('disableCooling'); setDisableCoolingDraft(CORE.disableCooling); }, controlsDisabled)}
              title={t('config.network.disableCooling')}
              description={t('config.network.disableCoolingHint')}
              control={<Switch checked={disableCoolingDraft} disabled={controlsDisabled} aria-label={t('config.network.disableCooling')} onCheckedChange={(checked) => { markDraftDirty('disableCooling'); setDisableCoolingDraft(checked); }} />}
            />
            <SettingsRow
              settingId="general.request-retry"
              reset={resetOffer(requestRetryDraft, CORE.requestRetry, String(CORE.requestRetry), () => { markDraftDirty('requestRetry'); setRequestRetryDraft(String(CORE.requestRetry)); setRetryError(''); }, controlsDisabled)}
              title={t('config.network.requestRetry')}
              description={t('config.network.requestRetryHint')}
              control={numericInput(requestRetryDraft, (next) => { markDraftDirty('requestRetry'); setRequestRetryDraft(next); setRetryError(''); }, () => { clearDraftDirty('requestRetry'); setRequestRetryDraft(String(settings?.requestRetry ?? '')); setRetryError(''); }, { maxLength: 10, invalid: Boolean(retryError), ariaLabel: t('config.network.requestRetry'), min: 0, max: 4294967295 })}
            />
            <SettingsRow
              settingId="general.max-retry-credentials"
              reset={resetOffer(maxRetryCredentialsDraft, CORE.maxRetryCredentials, String(CORE.maxRetryCredentials), () => { markDraftDirty('maxRetryCredentials'); setMaxRetryCredentialsDraft(String(CORE.maxRetryCredentials)); setRetryError(''); }, controlsDisabled)}
              title={t('config.network.maxRetryCredentials')}
              description={t('config.network.maxRetryCredentialsHint')}
              control={numericInput(maxRetryCredentialsDraft, (next) => { markDraftDirty('maxRetryCredentials'); setMaxRetryCredentialsDraft(next); setRetryError(''); }, () => { clearDraftDirty('maxRetryCredentials'); setMaxRetryCredentialsDraft(String(settings?.maxRetryCredentials ?? '')); setRetryError(''); }, { maxLength: 10, invalid: Boolean(retryError), ariaLabel: t('config.network.maxRetryCredentials'), min: 0, max: 4294967295 })}
            />
            <SettingsRow
              settingId="general.max-retry-interval"
              reset={resetOffer(maxRetryIntervalDraft, CORE.maxRetryInterval, withUnit(CORE.maxRetryInterval, t('config.unit.seconds')), () => { markDraftDirty('maxRetryInterval'); setMaxRetryIntervalDraft(String(CORE.maxRetryInterval)); setRetryError(''); }, controlsDisabled)}
              title={t('config.network.maxRetryInterval')}
              description={t('config.network.maxRetryIntervalHint')}
              control={numericInput(maxRetryIntervalDraft, (next) => { markDraftDirty('maxRetryInterval'); setMaxRetryIntervalDraft(next); setRetryError(''); }, () => { clearDraftDirty('maxRetryInterval'); setMaxRetryIntervalDraft(String(settings?.maxRetryInterval ?? '')); setRetryError(''); }, { maxLength: 10, invalid: Boolean(retryError), ariaLabel: t('config.network.maxRetryInterval'), min: 0, max: 4294967295, unit: t('config.unit.seconds') })}
            />
            <SettingsRow
              settingId="general.streaming-bootstrap-retries"
              reset={resetOffer(streamingBootstrapRetriesDraft, CORE.streamingBootstrapRetries, String(CORE.streamingBootstrapRetries), () => { markDraftDirty('streamingBootstrapRetries'); setStreamingBootstrapRetriesDraft(String(CORE.streamingBootstrapRetries)); setRetryError(''); }, controlsDisabled)}
              title={t('config.network.streamingBootstrapRetries')}
              description={t('config.network.streamingBootstrapRetriesHint')}
              status={retryError ? <span className="text-error-foreground">{retryError}</span> : null}
              control={numericInput(streamingBootstrapRetriesDraft, (next) => { markDraftDirty('streamingBootstrapRetries'); setStreamingBootstrapRetriesDraft(next); setRetryError(''); }, () => { clearDraftDirty('streamingBootstrapRetries'); setStreamingBootstrapRetriesDraft(String(settings?.streamingBootstrapRetries ?? '')); setRetryError(''); }, { maxLength: 10, invalid: Boolean(retryError), ariaLabel: t('config.network.streamingBootstrapRetries'), min: 0, max: 4294967295 })}
            />
            {feedbackBlock(retryFeedback)}
          </FoldedSettingsSection>

          <FoldedSettingsSection
            fold="tls"
            title={t('config.tls.title')}
            description={t('config.tls.restartHint')}
            changed={tlsChanged}
            attention={Boolean(tlsError)}
            headerAction={
              <div className="flex items-center gap-2">
                {tlsStatusLabel ? <Badge variant="muted">{tlsStatusLabel}</Badge> : null}
                {saveButton(t('config.network.save'), busyAction === 'tls', tlsFieldsDisabled || !tlsSettingsDirty, () => void saveTlsSettings())}
              </div>
            }
          >
            <SettingsRow
              settingId="general.tls"
              reset={resetOffer(tlsEnabledDraft, CORE.tlsEnabled, onOff(CORE.tlsEnabled), () => { setTlsError(''); setTlsEnabledDraft(CORE.tlsEnabled); }, tlsControlsDisabled)}
              title={t('config.tls.enable')}
              description={t('config.tls.enableDescription')}
              control={
                <Switch
                  checked={tlsEnabledDraft}
                  disabled={tlsControlsDisabled}
                  aria-label={t('config.tls.enable')}
                  onCheckedChange={(checked) => {
                    setTlsError('');
                    setTlsEnabledDraft(checked);
                  }}
                />
              }
            />
            {tlsEnabledDraft ? (
              <>
                <SettingsRow
                  settingId="general.tls-cert"
                  title={t('config.tls.cert')}
                  description={t('config.tls.certHint')}
                  control={
                    <div className="flex w-96 items-center gap-2">
                      <Input
                        type="text"
                        value={tlsCertDraft}
                        aria-label={t('config.tls.cert')}
                        aria-invalid={Boolean(tlsError && !tlsCertDraft.trim()) || undefined}
                        disabled={tlsFieldsDisabled}
                        placeholder={t('config.tls.certPlaceholder')}
                        font="mono"
                        onChange={(event) => {
                          setTlsError('');
                          setTlsCertDraft(event.currentTarget.value);
                        }}
                      />
                      <Button variant="outline" size="sm" className="shrink-0" disabled={tlsFieldsDisabled} focusableWhenDisabled title={t('config.tls.selectCertTitle')} onClick={() => void selectTlsFile('cert')}>
                        {tlsFileSelecting === 'cert' ? <Spinner /> : <FolderOpen />}
                        {t('config.tls.browse')}
                      </Button>
                    </div>
                  }
                />
                <SettingsRow
                  settingId="general.tls-key"
                  title={t('config.tls.key')}
                  description={t('config.tls.keyHint')}
                  control={
                    <div className="flex w-96 items-center gap-2">
                      <Input
                        type="text"
                        value={tlsKeyDraft}
                        aria-label={t('config.tls.key')}
                        aria-invalid={Boolean(tlsError && !tlsKeyDraft.trim()) || undefined}
                        disabled={tlsFieldsDisabled}
                        placeholder={t('config.tls.keyPlaceholder')}
                        font="mono"
                        onChange={(event) => {
                          setTlsError('');
                          setTlsKeyDraft(event.currentTarget.value);
                        }}
                      />
                      <Button variant="outline" size="sm" className="shrink-0" disabled={tlsFieldsDisabled} focusableWhenDisabled title={t('config.tls.selectKeyTitle')} onClick={() => void selectTlsFile('key')}>
                        {tlsFileSelecting === 'key' ? <Spinner /> : <FolderOpen />}
                        {t('config.tls.browse')}
                      </Button>
                    </div>
                  }
                />
              </>
            ) : null}
            {tlsError ? (
              <SettingsBlock>
                <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{tlsError}</AlertDescription></Alert>
              </SettingsBlock>
            ) : null}
          </FoldedSettingsSection>

          <FoldedSettingsSection
            fold="logging"
            title={t('config.diagnostics.title')}
            description={t('config.diagnostics.description')}
            changed={loggingChanged}
            attention={Boolean(loggingFeedback.notice || loggingError)}
            headerAction={saveButton(t('config.diagnostics.save'), loggingSettingsBusy, controlsDisabled || !loggingSettingsDirty, () => void saveCoreLoggingSettings())}
          >
            <SettingsRow
              settingId="general.debug"
              reset={resetOffer(debugDraft, CORE.debug, onOff(CORE.debug), () => { setDebugDraft(CORE.debug); markLoggingDraftDirty(); }, controlsDisabled)}
              title={t('config.diagnostics.debug.title')}
              description={t('config.diagnostics.debug.description')}
              control={<Switch checked={debugDraft} disabled={controlsDisabled} aria-label={t('config.diagnostics.debug.title')} onCheckedChange={(checked) => { setDebugDraft(checked); markLoggingDraftDirty(); }} />}
            />
            <SettingsRow
              settingId="general.commercial-mode"
              reset={resetOffer(commercialModeDraft, CORE.commercialMode, onOff(CORE.commercialMode), () => { setCommercialModeDraft(CORE.commercialMode); markLoggingDraftDirty(); }, controlsDisabled)}
              title={t('config.diagnostics.commercial.title')}
              description={t('config.diagnostics.commercial.description')}
              status={commercialModeDraft ? <span className="text-warning-foreground">{t('config.diagnostics.commercial.warning')}</span> : null}
              control={<Switch checked={commercialModeDraft} disabled={controlsDisabled} aria-label={t('config.diagnostics.commercial.title')} onCheckedChange={(checked) => { setCommercialModeDraft(checked); markLoggingDraftDirty(); }} />}
            />
            <SettingsRow
              settingId="general.file-logging"
              reset={resetOffer(loggingToFileDraft, CORE.loggingToFile, onOff(CORE.loggingToFile), () => { setLoggingToFileDraft(CORE.loggingToFile); markLoggingDraftDirty(); }, controlsDisabled)}
              title={t('config.diagnostics.fileLogging.title')}
              description={t('config.diagnostics.fileLogging.description')}
              control={<Switch checked={loggingToFileDraft} disabled={controlsDisabled} aria-label={t('config.diagnostics.fileLogging.title')} onCheckedChange={(checked) => { setLoggingToFileDraft(checked); markLoggingDraftDirty(); }} />}
            />
            <SettingsRow
              settingId="general.usage-statistics"
              title={t('config.diagnostics.usage.title')}
              description={t('config.diagnostics.usage.description')}
              status={usageStatisticsDraft ? null : <span className="text-warning-foreground">{t('config.diagnostics.usage.offWarning')}</span>}
              control={<Switch checked={usageStatisticsDraft} disabled={controlsDisabled} aria-label={t('config.diagnostics.usage.title')} onCheckedChange={(checked) => { setUsageStatisticsDraft(checked); markLoggingDraftDirty(); }} />}
            />
            <SettingsRow
              settingId="general.logs-max-size"
              reset={resetOffer(logsMaxTotalSizeDraft, CORE.logsMaxTotalSizeMb, withUnit(CORE.logsMaxTotalSizeMb, t('config.unit.megabytes')), () => { setLogsMaxTotalSizeDraft(String(CORE.logsMaxTotalSizeMb)); markLoggingDraftDirty(); }, controlsDisabled)}
              title={t('config.diagnostics.maxSize.title')}
              description={t('config.diagnostics.maxSize.hint')}
              control={
                <NumberField min={0} max={4294967295} value={numberFromDraft(logsMaxTotalSizeDraft)} disabled={controlsDisabled} aria-label={t('config.diagnostics.maxSize.title')} unit={t('config.unit.megabytes')} wrapperClassName="w-28" font="mono" className="text-right" onValueChange={(next) => { setLogsMaxTotalSizeDraft(draftFromNumber(next)); markLoggingDraftDirty(); }} />
              }
            />
            <SettingsRow
              settingId="general.error-log-files"
              reset={resetOffer(errorLogsMaxFilesDraft, CORE.errorLogsMaxFiles, String(CORE.errorLogsMaxFiles), () => { setErrorLogsMaxFilesDraft(String(CORE.errorLogsMaxFiles)); markLoggingDraftDirty(); }, controlsDisabled)}
              title={t('config.diagnostics.errorFiles.title')}
              description={t('config.diagnostics.errorFiles.hint')}
              control={
                <NumberField min={0} max={4294967295} value={numberFromDraft(errorLogsMaxFilesDraft)} disabled={controlsDisabled} aria-label={t('config.diagnostics.errorFiles.title')} wrapperClassName="w-28" font="mono" className="text-right" onValueChange={(next) => { setErrorLogsMaxFilesDraft(draftFromNumber(next)); markLoggingDraftDirty(); }} />
              }
            />
            <SettingsRow
              settingId="general.redis-retention"
              reset={resetOffer(redisUsageRetentionDraft, CORE.redisUsageQueueRetentionSeconds, withUnit(CORE.redisUsageQueueRetentionSeconds, t('config.unit.seconds')), () => { setRedisUsageRetentionDraft(String(CORE.redisUsageQueueRetentionSeconds)); markLoggingDraftDirty(); }, controlsDisabled)}
              title={t('config.diagnostics.redisRetention.title')}
              description={t('config.diagnostics.redisRetention.hint')}
              control={
                <NumberField min={1} max={3600} value={numberFromDraft(redisUsageRetentionDraft)} disabled={controlsDisabled} aria-label={t('config.diagnostics.redisRetention.title')} unit={t('config.unit.seconds')} wrapperClassName="w-28" font="mono" className="text-right" onValueChange={(next) => { setRedisUsageRetentionDraft(draftFromNumber(next)); markLoggingDraftDirty(); }} />
              }
            />
            {loggingError ? (
              <SettingsBlock>
                <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{loggingError}</AlertDescription></Alert>
              </SettingsBlock>
            ) : null}
            <SettingsBlock className="flex items-center justify-between gap-4 bg-muted/40 py-2.5 dark:bg-input/10">
              <span className="text-xs text-muted-foreground">{t('config.diagnostics.openLogsHint')}</span>
              <Button variant="outline" size="sm" disabled={controlsDisabled} onClick={() => void openCoreLogsDirectory()}>
                <FolderOpen />
                {t('config.diagnostics.openLogs')}
              </Button>
            </SettingsBlock>
            {feedbackBlock(loggingFeedback)}
          </FoldedSettingsSection>
        </PageBody>
      ) : activeSubpage === 'routing' ? (
        <PageBody>
          <SettingsSection
            title={t('config.network.routingSection')}
            headerAction={saveButton(t('config.network.save'), busyAction === 'routing', controlsDisabled || !sessionRoutingDirty || Boolean(sessionTtlError), () => void saveSessionRoutingSettings())}
          >
            <SettingsRow
              settingId="routing.session-affinity"
              reset={resetOffer(sessionAffinityDraft, CORE.routingSessionAffinity, onOff(CORE.routingSessionAffinity), () => { markDraftDirty('sessionAffinity'); setSessionAffinityDraft(CORE.routingSessionAffinity); }, controlsDisabled)}
              title={t('config.network.sessionAffinity')}
              description={t('config.network.sessionAffinityHint')}
              control={<Switch checked={sessionAffinityDraft} disabled={controlsDisabled} aria-label={t('config.network.sessionAffinity')} onCheckedChange={(checked) => { markDraftDirty('sessionAffinity'); setSessionAffinityDraft(checked); }} />}
            />
            <SettingsRow
              settingId="routing.session-ttl"
              title={t('config.network.sessionTtl')}
              description={t('config.network.sessionTtlHint')}
              status={sessionTtlError ? <span className="text-error-foreground">{t(sessionTtlError)}</span> : null}
              control={
                <Input
                  type="text"
                  value={sessionTtlDraft}
                  aria-invalid={Boolean(sessionTtlError) || undefined}
                  disabled={controlsDisabled}
                  placeholder="1h"
                  aria-label={t('config.network.sessionTtl')}
                  wrapperClassName="w-28"
                  font="mono"
                  className="text-right"
                  onChange={(event) => { markDraftDirty('sessionTtl'); setSessionTtlDraft(event.currentTarget.value); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('sessionTtl');
                      setSessionTtlDraft(settings.routingSessionAffinityTtl);
                      event.currentTarget.blur();
                    }
                  }}
                />
              }
            />
            {feedbackBlock(routingFeedback)}
          </SettingsSection>

          <SettingsSection title={t('config.routing.title')} description={t('config.routing.description')}>
            <SettingsRow
              settingId="routing.strategy"
              reset={settings ? resetOffer(settings.routingStrategy, CORE.routingStrategy, t('config.routing.roundRobin'), () => void changeRoutingStrategy(CORE.routingStrategy), controlsDisabled) : undefined}
              title={t('config.routing.rowTitle')}
              description={loading ? t('common.loading') : settings === null ? t('common.unavailable') : t('config.routing.current', { strategy: routingStrategyLabel(settings.routingStrategy, t) })}
              control={
                <ToggleGroup
                  value={settings?.routingStrategy ? [settings.routingStrategy] : []}
                  disabled={controlsDisabled}
                  aria-label={t('config.routing.title')}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (typeof next === 'string') void changeRoutingStrategy(next);
                  }}
                >
                  {ROUTING_OPTIONS.map((option) => (
                    <Toggle key={option.value} value={option.value} className="h-7 px-3 text-sm" title={option.value}>
                      {t(option.labelKey)}
                    </Toggle>
                  ))}
                </ToggleGroup>
              }
            />
          </SettingsSection>

          <AccountOrderSection />
        </PageBody>
      ) : activeSubpage === 'software' ? (
        <PageBody>
          <SoftwareSettingsSection />
          <CommandLineSettings />
          <QuitGuardSettings />
          <UsageDataSettings />
        </PageBody>
      ) : (
        <PageBody>
          <ThinkingAliasesPage />
        </PageBody>
      )}

      <Dialog open={addDialogOpen} onOpenChange={(next) => { if (!next) closeAddDialog(); }}>
        <DialogPopup className="max-w-md" showCloseButton={!keyMutationBusy}>
          <form className="contents" onSubmit={(event) => void submitApiKey(event)}>
            <DialogHeader>
              <DialogTitle>{editingApiKey === null ? t('config.keys.addTitle') : t('config.keys.editTitle')}</DialogTitle>
              <DialogDescription>{t('config.keys.remarkPlaceholder')}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="config-api-key-input">{t('config.keys.label')}</Label>
                <Input
                  id="config-api-key-input"
                  autoFocus
                  type={showApiKey ? 'text' : 'password'}
                  value={newApiKey}
                  onChange={(event) => {
                    setNewApiKey(event.currentTarget.value);
                    setFormError('');
                  }}
                  disabled={keyMutationBusy}
                  aria-invalid={Boolean(formError) || undefined}
                  placeholder="sk-..."
                  font="mono"
                  endAddon={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      onClick={() => setShowApiKey((visible) => !visible)}
                      disabled={keyMutationBusy}
                      aria-label={showApiKey ? t('config.keys.hide') : t('config.keys.show')}
                    >
                      {showApiKey ? <EyeOff /> : <Eye />}
                    </Button>
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="config-api-key-remark">{t('config.keys.remark')}</Label>
                <Input
                  id="config-api-key-remark"
                  type="text"
                  value={newApiKeyRemark}
                  maxLength={80}
                  onChange={(event) => {
                    setNewApiKeyRemark(event.currentTarget.value);
                    setFormError('');
                  }}
                  disabled={keyMutationBusy}
                  placeholder={t('config.keys.remarkPlaceholder')}
                />
              </div>
              {formError ? (
                <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{formError}</AlertDescription></Alert>
              ) : null}
              {renderFeedback(keyFeedback)}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" className="me-auto" onClick={generateApiKey} disabled={keyMutationBusy}>
                <Sparkles />
                {t('config.keys.generate')}
              </Button>
              <Button type="button" variant="ghost-muted" onClick={closeAddDialog} disabled={keyMutationBusy}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={keyMutationBusy}>
                {keyMutationBusy ? <Spinner /> : editingApiKey === null ? <Plus /> : <Check />}
                {keyMutationBusy
                  ? editingApiKey === null ? t('config.keys.adding') : t('common.saving')
                  : editingApiKey === null ? t('common.add') : t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteIndex !== null} onOpenChange={(next) => { if (!next && busyAction !== 'delete-key') setDeleteIndex(null); }}>
        <DialogPopup className="max-w-md" showCloseButton={busyAction !== 'delete-key'}>
          <DialogHeader>
            <DialogTitle>{t('config.keys.deleteTitle')}</DialogTitle>
            <DialogDescription>{t('config.keys.delete')}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <code className="block truncate rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-sm text-foreground dark:bg-input/24">{maskApiKey(selectedDeleteKey)}</code>
            {deletingLastKey ? (
              <Alert variant="warning" icon={<AlertCircle />}><AlertDescription>{t('config.keys.deleteAllWarning')}</AlertDescription></Alert>
            ) : null}
            {renderFeedback(keyFeedback)}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteIndex(null)} disabled={busyAction === 'delete-key'}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={busyAction === 'delete-key'}>
              {busyAction === 'delete-key' ? <Spinner /> : <Trash2 />}
              {busyAction === 'delete-key' ? t('common.deleting') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </AlertDialog>
    </Page>
  );
}

function routingStrategyLabel(strategy: string | undefined, t: ReturnType<typeof useI18n>['t']) {
  if (!strategy) {
    return t('common.loading');
  }
  const option = ROUTING_OPTIONS.find((item) => item.value === strategy);
  return option ? t(option.labelKey) : strategy;
}
