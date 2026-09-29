import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Search } from './ui/icons';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useI18n } from '../i18n';
import { managementApi } from '../services/managementApi';
import { oauthModelsFromPayload, type OAuthModelDefinition } from '../services/oauthModels';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';

type AuthFileModelsDialogProps = {
  name: string;
  onClose: () => void;
};

export function AuthFileModelsDialog({ name, onClose }: AuthFileModelsDialogProps) {
  const { t } = useI18n();
  const [models, setModels] = useState<OAuthModelDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // Focused through the dialog rather than autoFocus, so the dialog notes what opened it first and hands the focus back.
  const searchRef = useRef<HTMLInputElement>(null);
  // A tick on the row itself says which model was copied.
  const { copy, copied } = useCopyToClipboard({ inline: true });

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setModels([]);
    setError('');
    void managementApi.get('/auth-files/models', { name })
      .then((payload) => { if (!canceled) setModels(oauthModelsFromPayload(payload)); })
      .catch((requestError: unknown) => { if (!canceled) setError(String(requestError)); })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [name]);

  const query = search.trim().toLowerCase();
  const visibleModels = models.filter((model) => [model.id, model.displayName ?? ''].join(' ').toLowerCase().includes(query));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="max-w-xl" initialFocus={searchRef}>
        <DialogHeader>
          <DialogTitle>{t('authFiles.models.viewTitle')}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs text-foreground">{name}</span>
            <span className="block pt-1">{t('authFiles.models.viewDescription')}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 px-6 pb-4">
          <Input ref={searchRef} value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t('authFiles.models.search')} startAddon={<Search />} type="search" />
          {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <div className="max-h-[50vh] min-h-32 overflow-y-auto rounded-lg border border-border/60">
            {loading ? (
              <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{t('authFiles.models.loading')}</div>
            ) : visibleModels.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">{t(models.length ? 'authFiles.models.noMatch' : 'authFiles.models.viewEmpty')}</div>
            ) : (
              <ul className="divide-y divide-border/50">
                {visibleModels.map((model) => (
                  <li key={model.id}>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                      onClick={() => void copy(model.id)}
                      title={t('authFiles.models.copyModel')}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm text-foreground">{model.id}</span>
                        {model.displayName ? <span className="block truncate text-xs text-muted-foreground">{model.displayName}</span> : null}
                      </span>
                      {copied === model.id ? <Check className="size-4 shrink-0 text-success" aria-hidden="true" /> : <Copy className="size-4 shrink-0 text-icon-muted" aria-hidden="true" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
