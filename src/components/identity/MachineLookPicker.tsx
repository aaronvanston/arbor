import { useId, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useMachineIdentities } from '../../hooks/useMachineIdentities';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { cn } from '../../lib/utils';
import { identityColorCss, identityColorIsLight } from '../../services/identityColors';
import { machineIconChoices, machineLookKey, setMachineLook, useMachineLookChoices } from '../../services/machineLook';
import type { MachineKind } from '../../services/machineIdentity';
import { MACHINE_NAME_MAX, machineNameTakenBy, setMachineName, useMachineName } from '../../services/machineNames';
import { ColorPicker } from './ColorPicker';
import { FillPicker } from './FillPicker';
import { MachinePill, useMachineLook, type MachinePillSize } from './Identity';
import { MachineIcon } from '../MachineIcon';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '../ui/popover';

const ICON_LABEL: Record<MachineKind, MessageKey> = {
  laptop: 'machines.look.icon.laptop',
  macMini: 'machines.look.icon.macMini',
  macStudio: 'machines.look.icon.macStudio',
  imac: 'machines.look.icon.imac',
  macPro: 'machines.look.icon.macPro',
  mac: 'machines.look.icon.mac',
  server: 'machines.look.icon.server',
};

/**
 * The name a machine is shown by, typed over its own. It's kept on Enter or on leaving the field, and Escape leaves it as
 * it was. A name another machine goes by is refused, so two pills never read the same.
 */
function MachineNameField({ name, inputRef, onDone }: { name: string; inputRef: RefObject<HTMLInputElement | null>; onDone: () => void }) {
  const { t } = useI18n();
  const shown = useMachineName(name);
  const machines = useMachineIdentities();
  const [draft, setDraft] = useState(shown);
  // Escape closes the popover, which takes focus off the field: that blur mustn't keep what Escape threw away.
  const canceled = useRef(false);
  const hintId = useId();
  const taken = machineNameTakenBy(name, draft, machines.keys());
  const keep = () => {
    if (canceled.current || taken) return false;
    setMachineName(name, draft);
    return true;
  };
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <label htmlFor={`${hintId}-input`} className="text-xs font-medium text-muted-foreground">{t('machines.name.label')}</label>
      <Input
        ref={inputRef}
        id={`${hintId}-input`}
        size="sm"
        value={draft}
        placeholder={name}
        maxLength={MACHINE_NAME_MAX}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={taken ? true : undefined}
        aria-describedby={hintId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={keep}
        onKeyDown={(event) => {
          if (event.key === 'Escape') canceled.current = true;
          if (event.key !== 'Enter') return;
          // Focus goes back to the pill as the popover closes, and Enter's keypress would press it open again.
          event.preventDefault();
          if (keep()) onDone();
        }}
      />
      <p id={hintId} className={cn('text-xs', taken ? 'text-error-foreground' : 'text-muted-foreground')} role={taken ? 'alert' : undefined}>
        {taken ? t('machines.name.taken', { name: taken }) : t('machines.name.hint', { own: name })}
      </p>
    </div>
  );
}

/**
 * A machine's pill that opens its name and look: what it's called in Arbor, its color (the palette or any other), how
 * the pill is filled, and its icon. They apply at once, everywhere the machine is named, and stay on this Mac.
 */
export function MachineLookPicker({ name, size = 'md' }: { name: string; size?: MachinePillSize }) {
  const { t, tRich } = useI18n();
  const [open, setOpen] = useState(false);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const look = useMachineLook(name);
  const choice = useMachineLookChoices()[machineLookKey(name)];
  const shown = useMachineName(name);
  const swatch = 'relative flex size-6 cursor-pointer items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const option = (selected: boolean) =>
    cn(swatch, 'border text-muted-foreground hover:bg-accent hover:text-foreground', selected ? 'border-foreground/40 bg-accent text-foreground' : 'border-border/70');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('machines.look.edit', { machine: name })}
            title={t('machines.look.edit', { machine: name })}
          />
        }
      >
        <MachinePill name={name} size={size} />
      </PopoverTrigger>
      {/* Opens on the name, all of it selected, so typing renames it. */}
      <PopoverPopup width="md" padding="compact" align="start" initialFocus={() => { nameInput.current?.select(); return nameInput.current; }}>
        <PopoverTitle className="text-sm font-medium">{tRich('machines.look.title', { machine: <MachinePill name={name} size="md" /> })}</PopoverTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('machines.look.description')}</p>
        {/* Keyed by the name kept, so Back to automatic shows the machine's own name in the field again. */}
        <MachineNameField key={shown} name={name} inputRef={nameInput} onDone={() => setOpen(false)} />
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('machines.look.color')}</span>
          <ColorPicker value={look.color} onChange={(color) => setMachineLook(name, { color })} label={t('machines.look.color')} />
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('machines.look.fill')}</span>
          <FillPicker
            value={look.fill}
            onChange={(fill) => setMachineLook(name, { fill })}
            label={t('machines.look.fill')}
            preview={(fill) => (
              // A small pill filled this way, in this machine's color.
              <span
                className="machine-pill inline-flex h-4 w-6 shrink-0 rounded-[0.25rem]"
                style={{ '--machine-color': identityColorCss(look.color) } as CSSProperties}
                data-fill={fill}
                data-ink={fill === 'solid' && identityColorIsLight(look.color) ? 'dark' : undefined}
                aria-hidden="true"
              />
            )}
          />
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('machines.look.icon')}</span>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('machines.look.icon')}>
            {machineIconChoices.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={look.icon === kind}
                aria-label={t(ICON_LABEL[kind])}
                title={t(ICON_LABEL[kind])}
                className={option(look.icon === kind)}
                onClick={() => setMachineLook(name, { icon: kind })}
              >
                <MachineIcon kind={kind} className="size-3.5" />
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/50 pt-3">
          <MachinePill name={name} size="lg" />
          {choice || shown !== name ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setMachineLook(name, { color: undefined, icon: undefined, fill: undefined });
                setMachineName(name, '');
              }}
            >
              {t('machines.look.reset')}
            </Button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
