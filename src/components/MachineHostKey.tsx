import { useState } from 'react';
import { useI18n } from '../i18n';
import { invokeCommand } from '../native/commands';
import type { MachineHostKeyScan } from '../native/types';
import { readCommandError } from '../services/commandError';
import { hostKeyCheckCommand } from '../services/machineAlerts';
import { plainError } from '../services/plainError';
import { CommandLine } from './CommandLine';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { KeyRound } from './ui/icons';
import { Spinner } from './ui/spinner';
import { toast } from './ui/toast';

type Step =
  | { kind: 'reading' }
  | { kind: 'found'; scan: MachineHostKeyScan }
  | { kind: 'failed'; error: string };

/**
 * What the dialog shows while it reads the key, once it has it, or why it couldn't: the fingerprints in mono, and how
 * to see the machine's own to compare.
 */
export function HostKeyStep({ machine, step }: { machine: string; step: Step }) {
  const { t } = useI18n();
  if (step.kind === 'reading') {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('machines.hostKey.reading')}</p>;
  }
  if (step.kind === 'failed') return <p className="text-sm text-error-foreground" role="alert">{step.error}</p>;
  const { fingerprints } = step.scan;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1" aria-label={t('machines.hostKey.fingerprints')}>
        {fingerprints.map((fingerprint) => (
          <li key={fingerprint} className="break-all font-mono text-xs text-foreground">{fingerprint}</li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('machines.hostKey.compare', { machine })}</p>
      <CommandLine command={hostKeyCheckCommand(fingerprints)} />
    </div>
  );
}

/**
 * Connect, for a machine whose checks fail because its host key isn't trusted yet: reads the key the machine offers,
 * shows its fingerprints to compare, and trusts it only when the user says so. Arbor never trusts one on its own.
 */
export function ConnectMachineButton({ machine, className }: { machine: string; className?: string }) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step | null>(null);
  const [trusting, setTrusting] = useState(false);

  const read = async () => {
    setStep({ kind: 'reading' });
    try {
      const scan = await invokeCommand('scan_machine_host_key', { machine });
      if (scan.alreadyTrusted) {
        setStep(null);
        toast({ title: t('machines.hostKey.alreadyTrusted', { machine }) });
        return;
      }
      setStep({ kind: 'found', scan });
    } catch (reason) {
      setStep({ kind: 'failed', error: plainError(reason, t) });
    }
  };

  const trust = async () => {
    if (step?.kind !== 'found') return;
    setTrusting(true);
    try {
      await invokeCommand('trust_machine_host_key', { machine, fingerprints: step.scan.fingerprints });
      setStep(null);
      toast({ title: t('machines.hostKey.trusted', { machine }) });
    } catch (reason) {
      const failure = readCommandError(reason);
      // Nothing is trusted when the key isn't the one shown; it has to be read and compared again.
      setStep({ kind: 'failed', error: failure.kind === 'changed' ? t('machines.hostKey.changedSinceRead', { machine }) : plainError(reason, t) });
    } finally {
      setTrusting(false);
    }
  };

  const close = () => {
    if (!trusting) setStep(null);
  };

  // Events from the dialog bubble through React to the rows that open a machine's page when clicked, so they stop here.
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <span className="contents" onClick={stop} onKeyDown={stop}>
      <Button variant="outline" size="xs" className={className} onClick={() => void read()}>
        <KeyRound />
        {t('machines.hostKey.connect')}
      </Button>
      <Dialog open={step !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t('machines.hostKey.title', { machine })}</DialogTitle>
            <DialogDescription>{t('machines.hostKey.description', { machine })}</DialogDescription>
          </DialogHeader>
          <DialogPanel>{step ? <HostKeyStep machine={machine} step={step} /> : null}</DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={trusting} onClick={close}>{t('common.cancel')}</Button>
            {step?.kind === 'failed' ? (
              <Button type="button" onClick={() => void read()}>{t('machines.hostKey.readAgain')}</Button>
            ) : (
              <Button type="button" disabled={step?.kind !== 'found' || trusting} disabledReason={step?.kind === 'reading' ? t('machines.hostKey.reading') : undefined} onClick={() => void trust()}>
                {trusting ? <Spinner /> : <KeyRound />}
                {t('machines.hostKey.trust')}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </span>
  );
}
