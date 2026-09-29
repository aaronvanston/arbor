import { useState } from 'react';
import { invokeCommand } from '../native/commands';
import { AlertCircle, Monitor } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { useUnsavedChanges } from '../services/unsavedChanges';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import type { MachineAssignment } from '../native/types';

export function UsageMachineAssignments({ assignments, onSaved }: { assignments: MachineAssignment[]; onSaved: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<MachineAssignment[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const change = (index: number, field: 'machine' | 'pool', value: string) => {
    setDraft(rows => rows?.map((row, i) => i === index ? { ...row, [field]: value } : row) ?? null);
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true); setError('');
    try {
      await invokeCommand('save_usage_machine_assignments', { assignments: draft });
      setDraft(null); onSaved();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };
  useUnsavedChanges(draft !== null && JSON.stringify(draft) !== JSON.stringify(assignments));
  const assignedCount = assignments.filter((item) => item.machine).length;
  return (
    <SettingsSection
      settingId="machines.assignments"
      title={t('usage.assignments.title')}
      description={t('usage.assignments.description')}
      headerAction={
        !draft ? (
          <Button variant="outline" size="sm" onClick={() => { setDraft(assignments.map(a => ({ ...a }))); setError(''); }}>
            <Monitor />
            {t('usage.fleet.assign')}
          </Button>
        ) : null
      }
    >
      {draft ? (
        <>
          {draft.length === 0 ? (
            <SettingsBlock className="text-sm text-muted-foreground">{t('usage.assignments.empty')}</SettingsBlock>
          ) : (
            draft.map((row, index) => {
              const keyLabel = row.label || t('usage.assignments.unnamedKey');
              return (
                <SettingsRow
                  key={row.api_key_hash}
                  title={keyLabel}
                  description={<span className="font-mono text-xs">{t('usage.assignments.fingerprint', { hash: row.api_key_hash.slice(0, 10) })}</span>}
                  control={
                    <Input
                      wrapperClassName="w-64"
                      aria-label={t('usage.assignments.machineFor', { key: row.label || row.api_key_hash.slice(0, 10) })}
                      value={row.machine}
                      maxLength={100}
                      disabled={saving}
                      onChange={e => change(index, 'machine', e.target.value)}
                      placeholder={t('usage.assignments.placeholder')}
                    />
                  }
                />
              );
            })
          )}
          {error ? (
            <SettingsBlock>
              <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert>
            </SettingsBlock>
          ) : null}
          <SettingsBlock className="flex items-center justify-end gap-2 bg-muted/40 dark:bg-input/16">
            <Button variant="outline" disabled={saving} onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner /> : null}
              {saving ? t('usage.assignments.saving') : t('usage.assignments.save')}
            </Button>
          </SettingsBlock>
        </>
      ) : (
        <SettingsBlock className="text-sm text-muted-foreground">
          {t('usage.assignments.summary', { assigned: assignedCount, total: assignments.length })}
        </SettingsBlock>
      )}
    </SettingsSection>
  );
}
