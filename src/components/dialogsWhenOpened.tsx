import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import { useI18n } from '../i18n';
import { mockableChunk } from '../lib/mockableChunk';
import { plainError } from '../services/plainError';
import { toast } from './ui/toast';

/**
 * A dialog whose code loads the first time it opens, rather than with the app: each brings libraries and services that
 * only it uses. It mounts once its code is here, and stays mounted after, so it can close with its animation and opens
 * at once the next time. Not through `lazy()`: a suspended dialog would show 300 ms late, as React holds back what
 * appears after a Suspense fallback, where the code itself takes a few milliseconds.
 */
function whenOpened<P extends { open: boolean }>(load: () => Promise<ComponentType<P>>, close: (props: P) => void) {
  const importDialog = mockableChunk(load);
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const loadDialog = () => {
    loading ??= importDialog().then(
      (component) => (loaded = component),
      (error: unknown) => {
        // Tried again on the next open.
        loading = null;
        throw error;
      },
    );
    return loading;
  };
  return function DialogWhenOpened(props: P) {
    const { t } = useI18n();
    // Held as { component } since a component is itself a function, which useState would call.
    const [dialog, setDialog] = useState(() => (loaded ? { component: loaded } : null));
    const opening = props.open && !dialog;
    const latest = useRef(props);
    latest.current = props;
    useEffect(() => {
      if (!opening) return undefined;
      let live = true;
      loadDialog().then(
        (component) => { if (live) setDialog({ component }); },
        (error: unknown) => {
          if (!live) return;
          // Nothing opened to show it beside, so it's a toast; the dialog is closed again so it can be tried again.
          toast({ kind: 'error', title: t('dialog.loadFailed', { error: plainError(error, t) }) });
          close(latest.current);
        },
      );
      return () => {
        live = false;
      };
    }, [opening, t]);
    if (!dialog) return null;
    const Dialog = dialog.component;
    return <Dialog {...props} />;
  };
}

type AddMachineProps = ComponentProps<typeof import('./AddMachineDialog').AddMachineDialog>;
type ConnectAgentProps = ComponentProps<typeof import('./ConnectAgentDialog').ConnectAgentDialog>;
type CommandPaletteProps = ComponentProps<typeof import('./CommandPalette').CommandPalette>;

export const AddMachineDialog = whenOpened<AddMachineProps>(
  () => import('./AddMachineDialog').then((module) => module.AddMachineDialog),
  (props) => props.onClose(),
);
export const ConnectAgentDialog = whenOpened<ConnectAgentProps>(
  () => import('./ConnectAgentDialog').then((module) => module.ConnectAgentDialog),
  (props) => props.onClose(),
);
export const CommandPalette = whenOpened<CommandPaletteProps>(
  () => import('./CommandPalette').then((module) => module.CommandPalette),
  (props) => props.onOpenChange(false),
);
