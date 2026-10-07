import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { accountInitials, avatarText, clearAccountProfile, resolveAccountProfile, saveAccountProfile, type AccountProfile } from '../services/accountProfiles';
import { useShownIdentity } from '../services/emailPrivacy';
import { AccountAvatar } from './AccountAvatar';
import { ColorPicker } from './identity/ColorPicker';
import { FillPicker } from './identity/FillPicker';
import { Button } from './ui/button';
import { toast } from './ui/toast';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

/** The account being edited: its key, file, email when it has one, and its profile as saved. */
export type ProfileTarget = { key: string; fileName: string; email?: string; profile: AccountProfile | undefined };

export function AccountProfileDialog({ target, onClose }: { target: ProfileTarget | null; onClose: () => void }) {
  const { t } = useI18n();
  const shown = useShownIdentity();
  const [draft, setDraft] = useState<AccountProfile>({});
  useEffect(() => {
    setDraft(target?.profile ? { ...target.profile } : {});
  }, [target]);
  const preview = target ? resolveAccountProfile(target.key, target.fileName, draft) : null;
  const submit = () => {
    if (!target) return;
    saveAccountProfile(target.key, draft);
    toast({ kind: 'success', title: t('accounts.profile.saved') });
    onClose();
  };
  // Reversible, so it happens at once with Undo rather than behind a confirm.
  const reset = () => {
    if (!target) return;
    const before = target.profile ? { ...target.profile } : {};
    const key = target.key;
    clearAccountProfile(key);
    onClose();
    toast({ kind: 'success', title: t('accounts.profile.wasReset'), action: { label: t('common.undo'), onClick: () => saveAccountProfile(key, before) } });
  };
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target && preview ? (
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('accounts.profile.title')}</DialogTitle>
            <DialogDescription>{t('accounts.profile.description')}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              id="account-profile-form"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 dark:bg-input/16">
                <AccountAvatar profile={preview} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{preview.name}</div>
                  {target.email ? <div className="truncate text-xs text-muted-foreground">{shown(target.email, { email: target.email })}</div> : null}
                  <div className="truncate font-mono text-2xs text-muted-foreground">
                    {t('accounts.profile.file')} · {shown(target.fileName, { fileName: target.fileName, email: target.email })}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="account-profile-name">{t('accounts.profile.name')}</Label>
                <Input
                  id="account-profile-name"
                  value={draft.name ?? ''}
                  maxLength={60}
                  placeholder={t('accounts.profile.namePlaceholder')}
                  onChange={(event) => { const name = event.currentTarget.value; setDraft((current) => ({ ...current, name })); }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="account-profile-avatar">{t('accounts.profile.avatar')}</Label>
                {/* Typed as it'll show: in capitals, three characters at most. Empty, it shows the initials it'll use. */}
                <Input
                  id="account-profile-avatar"
                  wrapperClassName="w-28"
                  value={draft.avatar ?? ''}
                  placeholder={accountInitials(draft.name?.trim() || target.fileName)}
                  onChange={(event) => { const avatar = avatarText(event.currentTarget.value); setDraft((current) => ({ ...current, avatar })); }}
                />
                <span className="text-xs text-muted-foreground">{t('accounts.profile.avatarHint')}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm/4 font-medium text-foreground">{t('accounts.profile.color')}</span>
                <ColorPicker value={preview.color} onChange={(color) => setDraft((current) => ({ ...current, color }))} label={t('accounts.profile.color')} />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm/4 font-medium text-foreground">{t('accounts.profile.fill')}</span>
                <FillPicker
                  value={preview.fill}
                  onChange={(fill) => setDraft((current) => ({ ...current, fill }))}
                  label={t('accounts.profile.fill')}
                  // This account's own avatar, filled each way.
                  preview={(fill) => <AccountAvatar profile={{ ...preview, fill }} size="xs" />}
                />
              </div>
            </form>
          </DialogPanel>
          <DialogFooter className="justify-between">
            <Button variant="ghost-muted" onClick={reset}>
              {t('accounts.profile.reset')}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
              <Button type="submit" form="account-profile-form">{t('common.save')}</Button>
            </div>
          </DialogFooter>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}
