import { useState } from 'react';
import { useI18n } from '../i18n';
import { addThisMac, requestAddMachine } from '../services/addMachine';
import { MachinePill } from './identity/Identity';
import { Button } from './ui/button';
import { Laptop, Plus } from './ui/icons';
import { Spinner } from './ui/spinner';
import { toast } from './ui/toast';

/**
 * What an empty machine list offers: this Mac in one click, then any other machine over SSH. `onAdded` gets the name
 * this Mac was listed under, to open its page.
 */
export function FirstMachineActions({ onAdded }: { onAdded?: (machine: string) => void }) {
  const { t, tRich } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const machine = await addThisMac();
      toast({ kind: 'success', title: tRich('machines.hosts.added', { machine: <MachinePill name={machine} size="md" /> }) });
      onAdded?.(machine);
    } catch (failure) {
      setError(t('machines.thisMac.failed', { error: String(failure) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void add()}>
          {busy ? <Spinner /> : <Laptop />}
          {t('machines.thisMac.add')}
        </Button>
        <Button variant="outline" size="sm" onClick={requestAddMachine}>
          <Plus />
          {t('machines.thisMac.other')}
        </Button>
      </div>
      {error ? <p className="text-xs text-error-foreground" role="alert">{error}</p> : null}
    </div>
  );
}
