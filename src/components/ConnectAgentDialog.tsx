import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { invokeCommand } from '../native/commands';
import type { CoreApiKeyView } from '../native/types';
import type { AppView } from '../navigation';
import { getThisMac } from '../services/addMachine';
import { addNewClientKey, clientKeyName, defaultClientKey, maskApiKey } from '../services/clientKeys';
import { agentSetup, listensOnlyHere, proxyOrigin, type AgentOrigin, type ProxyListen } from '../services/connectAgent';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { AlertCircle, Check, Copy, Laptop, Monitor } from './ui/icons';
import { Label } from './ui/label';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';
import { Toggle, ToggleGroup } from './ui/toggle-group';

type Loaded = { listen: ProxyListen; keys: CoreApiKeyView[]; thisMac: string };

/**
 * How to point Claude Code and Codex at the proxy, on this Mac or another machine: the lines to add to each one's
 * settings, with the proxy's address and key in them. The key shows masked; copying takes the real one.
 */
export function ConnectAgentDialog({ open, onClose, from = 'here', onNavigate }: {
  open: boolean;
  onClose: () => void;
  from?: AgentOrigin;
  onNavigate?: (view: AppView) => void;
}) {
  const { t } = useI18n();
  const [where, setWhere] = useState<AgentOrigin>(from);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyIndex, setKeyIndex] = useState(0);
  const [making, setMaking] = useState(false);
  const [makeError, setMakeError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setWhere(from);
    setKeyIndex(0);
    setError(null);
    setMakeError(null);
    Promise.all([
      invokeCommand('get_gui_settings'),
      invokeCommand('get_core_tls_settings').catch(() => ({ enabled: false })),
      invokeCommand('get_core_config_settings'),
      getThisMac().catch(() => ({ name: 'this-mac', listed: false })),
    ])
      .then(([gui, tls, core, thisMac]) => {
        if (current) setLoaded({ listen: { host: gui.host, port: gui.port, tls: tls.enabled }, keys: core.apiKeys, thisMac: thisMac.name });
      })
      .catch((failure) => { if (current) setError(String(failure)); });
    return () => { current = false; };
  }, [open, from]);

  const key = loaded ? loaded.keys[keyIndex] ?? defaultClientKey(loaded) : null;
  const origin = loaded ? proxyOrigin(loaded.listen, where, loaded.thisMac) : '';
  const real = key ? agentSetup(origin, key.apiKey) : null;
  const shown = key ? agentSetup(origin, maskApiKey(key.apiKey)) : null;
  const unreachable = where === 'other' && loaded !== null && listensOnlyHere(loaded.listen);

  // A new install's proxy has no key, since the core's example ones are left out. One made here is named for this Mac
  // when its agents are the ones connecting, so their requests are told apart from another machine's.
  const makeKey = async () => {
    if (!loaded) return;
    setMaking(true);
    setMakeError(null);
    try {
      const keys = await addNewClientKey(where === 'here' ? loaded.thisMac : '');
      setLoaded((current) => current && { ...current, keys });
      setKeyIndex(Math.max(0, keys.length - 1));
    } catch (failure) {
      setMakeError(String(failure));
    } finally {
      setMaking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('connectAgent.title')}</DialogTitle>
          <DialogDescription>{t('connectAgent.description')}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <ToggleGroup
              value={[where]}
              onValueChange={(value) => { const next = value[0]; if (next === 'here' || next === 'other') setWhere(next); }}
              aria-label={t('connectAgent.where')}
            >
              <Toggle value="here"><Laptop /> {t('connectAgent.here')}</Toggle>
              <Toggle value="other"><Monitor /> {t('connectAgent.other')}</Toggle>
            </ToggleGroup>
            {loaded && loaded.keys.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <Label>{t('connectAgent.key')}</Label>
                <Select value={String(keyIndex)} onValueChange={(next) => setKeyIndex(Number(next ?? 0))}>
                  <SelectTrigger size="sm" aria-label={t('connectAgent.key')}>
                    <SelectValue>{key ? clientKeyName(key) : ''}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {loaded.keys.map((entry, index) => <SelectItem key={entry.apiKeyHash} value={String(index)}>{clientKeyName(entry)}</SelectItem>)}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
          </div>
          {error ? (
            <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{t('connectAgent.failed', { error })}</AlertDescription></Alert>
          ) : !loaded ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner />{t('common.loading')}</p>
          ) : !real || !shown ? (
            <Alert variant="warning" icon={<AlertCircle />}>
              <AlertDescription className="flex flex-col items-start gap-2">
                {t('connectAgent.noKey')}
                <Button variant="outline" size="xs" onClick={() => void makeKey()} disabled={making}>
                  {making ? <Spinner /> : null}{t('connectAgent.makeKey')}
                </Button>
                {makeError ? <span className="text-error-foreground">{t('connectAgent.makeKeyFailed', { error: makeError })}</span> : null}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {unreachable ? (
                <Alert variant="warning" icon={<AlertCircle />}>
                  <AlertDescription className="flex flex-col items-start gap-2">
                    {t('connectAgent.localOnly', { host: loaded.listen.host })}
                    {onNavigate ? (
                      <Button variant="outline" size="xs" onClick={() => { onClose(); onNavigate({ kind: 'settings', page: 'general' }); }}>
                        {t('connectAgent.openNetwork')}
                      </Button>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : where === 'other' ? (
                <p className="text-xs text-muted-foreground">{t('connectAgent.otherHint', { address: origin })}</p>
              ) : null}
              <Snippet id="claude" title={t('connectAgent.claude.title')} file={t('connectAgent.claude.file')} shown={shown.claude} copied={real.claude} />
              <Snippet id="codex" title={t('connectAgent.codex.title')} file={t('connectAgent.codex.file')} shown={shown.codex} copied={real.codex} />
              <Snippet id="codex-key" file={t('connectAgent.codex.keyFile')} shown={shown.codexKey} copied={real.codexKey} />
              <p className="text-xs text-muted-foreground">{t('connectAgent.after')}</p>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Lines for one file, shown with the key masked; the button copies them with the real key. */
function Snippet({ id, title, file, shown, copied }: { id: string; title?: string; file: string; shown: string; copied: string }) {
  const { t } = useI18n();
  const { copy, copied: done } = useCopyToClipboard({ inline: true });
  const label = t(done === id ? 'setup.checklist.copied' : 'setup.checklist.copy');
  return (
    <section className="flex flex-col gap-1.5">
      {title ? <h3 className="text-sm font-medium text-foreground">{title}</h3> : null}
      <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/30 dark:bg-input/16">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 py-1 ps-3 pe-1">
          <span className="truncate text-xs text-muted-foreground">{file}</span>
          <Button variant="ghost-muted" size="icon-xs" onClick={() => void copy(copied, { id })} aria-label={label} title={label}>
            {done === id ? <Check /> : <Copy />}
          </Button>
        </div>
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed text-foreground">{shown}</pre>
      </div>
    </section>
  );
}
