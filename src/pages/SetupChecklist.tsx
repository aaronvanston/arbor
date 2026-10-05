import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpCircle, Check, ChevronDown, ListChecks, Plus } from '../components/ui/icons';
import { CommandLine } from '../components/CommandLine';
import { FixMenu } from '../components/FixMenu';
import { agentMissingProblem, healthProblem, projectsInLineProblem, settingsInLineProblem, toolsInLineProblem } from '../services/fixPrompt';
import { ConnectAgentDialog } from '../components/ConnectAgentDialog';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../components/ui/collapsible';
import { Progress } from '../components/ui/progress';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import type { AppView } from '../navigation';
import { useLatestAgentVersions } from '../services/agentReleases';
import { fetchMachineHealth, saveMachineHosts } from '../services/machineHealth';
import { formatAgo, formatCount } from '../lib/format';
import type { SetupCheck, SetupCheckSubject } from '../services/setupChecks';
import {
  agentsStep,
  alertsStep,
  checklistProgress,
  checklistReference,
  checksStep,
  connectStep,
  firstOpen,
  getKeyAssignments,
  getMachineRequests,
  mcpStep,
  pluginsStep,
  projectsStep,
  proxyStep,
  repoStep,
  settingsStep,
  shellWord,
  skillsStep,
  STEP_ORDER,
  toolsStep,
  type AgentFact,
  type KeyAssignment,
  type MachineRequests,
  type StepId,
  type StepState,
  waitsForHost,
} from '../services/setupChecklist';
import { homeKey, scanSetup } from '../services/setupInventory';
import { getMcpRegistry, withRegistry } from '../services/setupMcp';
import { extensionsView } from '../services/setupPlugins';
import { getProjects, scanProjects, SETUP_PROJECTS_UPDATED_EVENT } from '../services/setupProjects';
import { skillsView } from '../services/setupSkills';
import { getSetupRepo, storedSetupRepo } from '../services/setupSync';
import { getToolchain, scanToolchain, SETUP_TOOLCHAIN_UPDATED_EVENT } from '../services/setupToolchain';
import { UpdateOutcomeView, useAgentUpdate } from './MachineAgents';
import { MachineReporterRow } from './MachineReporter';
import { SetupChecks } from './SetupChecks';
import { ReviewDialog as ExtensionsReviewDialog } from './SetupPlugins';
import { SkillReviewDialog } from './SetupSkills';
import { SyncReviewDialog } from './SetupSync';
import { toolLabel } from './SetupToolchain';
import type {
  AgentKind,
  MachineHealth,
  MachineProjects,
  MachineToolchain,
  McpRegistry,
  PluginAction,
  SetupMachine,
  SetupRepo,
  SkillAction,
} from '../native/types';
import { MachinePill } from '../components/identity/Identity';
import { useNow } from '../hooks/useNow';

const REFERENCE_KEY = 'arbor.setup.checklist.reference.v1';
/** How often the agents and the reporter are looked at again, which the Machines page checks on its own schedule. */
const HEALTH_POLL_MS = 15_000;
/** How often a machine that isn't answering yet, as one just added isn't, is looked for again. */
const JOIN_POLL_MS = 4_000;
/** How many of a list a step shows before "and N more". */
const LIST_MAX = 8;

export type ChecklistTab = 'repo' | 'skills' | 'plugins' | 'projects' | 'toolchain';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * How a step's summary is written: in words for its tooltip, or with its machines as pills for the row itself. The
 * same summary is written both ways, so the two can't disagree.
 */
type Writer<T> = {
  /** A machine's name, as it is or as its pill. */
  machine: (name: string) => T | string;
  say: (key: MessageKey, values?: Record<string, string | number | T>) => T;
  join: (parts: T[]) => T;
};

const AGENT_NAME: Record<AgentKind, MessageKey> = {
  claude: 'machines.agents.name.claude',
  codex: 'machines.agents.name.codex',
};

const STATE_TEXT: Record<StepState, MessageKey> = {
  done: 'setup.checklist.state.done',
  todo: 'setup.checklist.state.todo',
  waiting: 'setup.checklist.state.waiting',
  unknown: 'setup.checklist.state.unknown',
  skip: 'setup.checklist.state.skip',
};

const STEP_TITLE: Record<StepId, MessageKey> = {
  connect: 'setup.checklist.connect.title',
  agents: 'setup.checklist.agents.title',
  proxy: 'setup.checklist.proxy.title',
  repo: 'setup.checklist.repo.title',
  skills: 'setup.checklist.skills.title',
  mcp: 'setup.checklist.mcp.title',
  plugins: 'setup.checklist.plugins.title',
  settings: 'setup.checklist.settings.title',
  alerts: 'setup.checklist.alerts.title',
  tools: 'setup.checklist.tools.title',
  projects: 'setup.checklist.projects.title',
  checks: 'setup.checklist.checks.title',
};

const SKILL_ACTION: Record<SkillAction, MessageKey> = {
  link: 'setup.checklist.skills.action.link',
  useStore: 'setup.checklist.skills.action.useStore',
  adopt: 'setup.checklist.skills.action.adopt',
  remove: 'setup.checklist.skills.action.remove',
};

const PLUGIN_ACTION: Record<PluginAction, MessageKey> = {
  addMarketplace: 'setup.checklist.plugins.action.addMarketplace',
  refresh: 'setup.checklist.plugins.action.refresh',
  install: 'setup.checklist.plugins.action.install',
  update: 'setup.checklist.plugins.action.update',
  enable: 'setup.checklist.plugins.action.enable',
  disable: 'setup.checklist.plugins.action.disable',
  uninstall: 'setup.checklist.plugins.action.uninstall',
  removeMarketplace: 'setup.checklist.plugins.action.removeMarketplace',
};

const KIND_LABEL: Partial<Record<string, MessageKey>> = {
  setting: 'setup.kind.setting',
  env: 'setup.kind.env',
  hook: 'setup.kind.hook',
  profile: 'setup.kind.profile',
};

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Choices are remembered where storage allows.
  }
};

const plural = (count: number, one: MessageKey, other: MessageKey, t: Translate, values: Record<string, string | number> = {}) =>
  t(count === 1 ? one : other, { count: formatCount(count), ...values });

/**
 * "Bring … in line", on a machine's own page: the `target` machine brought in line with another, a step at a time:
 * reaching it, its agents, the proxy, the setup repo's files, skills, MCP servers, plugins, settings, alerts, tools and
 * projects, then Sync's checks. Each step reads what Sync's views read and makes changes through their reviews. The
 * machine to match is picked here; the steps start `folded` until asked for.
 */
export function SetupChecklist({ machines, target, folded: startFolded = false, homeLabel, onReload, onOpenTab, onCompareSettings, onShowCheck, onCompareCheck, onNavigate }: {
  machines: SetupMachine[];
  target: string;
  folded?: boolean;
  homeLabel: (key: string) => string;
  onReload: () => void;
  onOpenTab: (tab: ChecklistTab, machine: string) => void;
  onCompareSettings: (reference: string, home: string | null) => void;
  onShowCheck: (home: string, name: string) => void;
  onCompareCheck: (check: SetupCheck, subject: SetupCheckSubject) => void;
  onNavigate: (view: AppView) => void;
}) {
  const { t, tRich } = useI18n();
  const now = useNow();
  const [chosenReference, setChosenReference] = useState<string | null>(() => readStored(REFERENCE_KEY));
  const [openState, setOpenState] = useState<{ target: string | null; ids: StepId[] } | null>(null);
  const [review, setReview] = useState<'repo' | 'skills' | 'mcp' | 'plugins' | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);

  const [folded, setFolded] = useState(startFolded);
  const machine = machines.find((entry) => entry.machine === target) ?? null;
  const referenceName = checklistReference(machines, target, chosenReference);
  const reference = machines.find((entry) => entry.machine === referenceName) ?? null;

  const chooseReference = (name: string) => {
    setChosenReference(name);
    store(REFERENCE_KEY, name);
  };

  // The agents, and whether the reporter is set up, as the Machines page last checked them.
  const [health, setHealth] = useState<MachineHealth[] | null>(null);
  const [healthUnread, setHealthUnread] = useState(false);
  const loadHealth = useCallback(async () => {
    try {
      setHealth((await fetchMachineHealth(Date.now(), 1_000, true)).machines);
      setHealthUnread(false);
    } catch {
      // The steps that need it keep waiting; the first says why, and the poll tries again.
      setHealthUnread(true);
    }
  }, []);
  useEffect(() => {
    void loadHealth();
    const timer = window.setInterval(() => void loadHealth(), HEALTH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadHealth]);

  const [repoPath] = useState(storedSetupRepo);
  const [repo, setRepo] = useState<SetupRepo | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const loadRepo = useCallback(async () => {
    if (!repoPath) return;
    try {
      setRepo(await getSetupRepo(repoPath));
      setRepoError(null);
    } catch (error) {
      setRepoError(String(error));
    }
  }, [repoPath]);
  useEffect(() => {
    void loadRepo();
    // The repo is edited outside Arbor, so it's read again whenever Arbor comes back to the front.
    const again = () => void loadRepo();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [loadRepo]);

  // The repo's servers are compared with each home as its last scan found it, so they're read again after each scan.
  const scans = machines.map((entry) => `${entry.machine}:${entry.scannedAt ?? ''}`).join('\n');
  const [registry, setRegistry] = useState<McpRegistry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  useEffect(() => {
    if (!repoPath) return undefined;
    let current = true;
    getMcpRegistry(repoPath)
      .then((next) => { if (current) { setRegistry(next); setRegistryError(null); } })
      .catch((error) => { if (current) { setRegistry(null); setRegistryError(String(error)); } });
    return () => { current = false; };
  }, [repoPath, scans]);

  const [assignments, setAssignments] = useState<KeyAssignment[] | null>(null);
  const [requests, setRequests] = useState<MachineRequests[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const [keys, seen] = await Promise.all([getKeyAssignments(), getMachineRequests(Date.now())]);
      setAssignments(keys);
      setRequests(seen);
      setUsageError(null);
    } catch (error) {
      setUsageError(String(error));
    } finally {
      setUsageLoading(false);
    }
  }, []);
  useEffect(() => { void loadUsage(); }, [loadUsage]);

  const [toolchain, setToolchain] = useState<MachineToolchain[] | null>(null);
  const [projects, setProjects] = useState<MachineProjects[] | null>(null);
  useEffect(() => {
    let disposed = false;
    const loadTools = () => getToolchain().then((list) => { if (!disposed) setToolchain(list); }).catch(() => { if (!disposed) setToolchain([]); });
    const loadProjects = () => getProjects().then((list) => { if (!disposed) setProjects(list); }).catch(() => { if (!disposed) setProjects([]); });
    void loadTools();
    void loadProjects();
    const stops: (() => void)[] = [];
    const follow = (event: string, load: () => Promise<void>) => {
      listen(event, () => { if (!disposed) void load(); })
        .then((stop) => { if (disposed) stop(); else stops.push(stop); })
        .catch(() => {});
    };
    follow(SETUP_TOOLCHAIN_UPDATED_EVENT, loadTools);
    follow(SETUP_PROJECTS_UPDATED_EVENT, loadProjects);
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);

  // Both machines are read once a visit where nothing has read them yet. Every one of these scans only reads.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const once = (key: string, run: () => Promise<unknown>) => {
      if (asked.current.has(key)) return;
      asked.current.add(key);
      void run().catch(() => undefined);
    };
    for (const entry of [machine, reference]) {
      if (!entry?.reachable) continue;
      const name = entry.machine;
      if (entry.scannedAt === null && !entry.scanning) once(`setup:${name}`, () => scanSetup(name, false));
      if (toolchain && !toolchain.some((found) => found.machine === name && (found.scannedAt !== null || found.scanning))) once(`tools:${name}`, () => scanToolchain(name));
      if (projects && !projects.some((found) => found.machine === name && (found.scannedAt !== null || found.scanning))) once(`projects:${name}`, () => scanProjects(name));
    }
  }, [machine, reference, toolchain, projects]);

  // A machine not answering yet, as one just added isn't, only shows up in the inventory once the machine list has it
  // and it answers, which nothing announces: it's looked for again until then. One with no host can't answer; the
  // health check every 15 seconds sees it once it has one.
  const looking = machine !== null && !machine.reachable && health?.find((entry) => entry.machine === target)?.status !== 'unconfigured';
  useEffect(() => {
    if (!looking) return undefined;
    const timer = window.setInterval(() => { onReload(); void loadHealth(); }, JOIN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [looking, onReload, loadHealth]);

  const targetHealth = health?.find((entry) => entry.machine === target) ?? null;
  const referenceHealth = health?.find((entry) => entry.machine === referenceName) ?? null;
  // Every machine but this Mac is on the machine list, which is what the agent updates and the reporter need.
  const listed = !machine?.local || health === null || targetHealth !== null;

  const view = useMemo(() => withRegistry(extensionsView(machines), registry), [machines, registry]);
  const latest = useLatestAgentVersions();
  const steps = useMemo(() => {
    if (!machine) return null;
    return {
      connect: connectStep(machine, targetHealth, healthUnread),
      // Arbor only runs on a Mac, so this one's system is known before its tools are looked at.
      agents: agentsStep(machine, machines, reference, machine.local ? 'Darwin' : toolchain?.find((entry) => entry.machine === machine.machine)?.os || null, latest),
      proxy: proxyStep(machine, reference, assignments, requests, usageError, now),
      repo: repoStep(repoPath, repo, repoError, machine),
      skills: skillsStep(machine, reference),
      mcp: mcpStep(machine, repoPath, registry, registryError, view),
      plugins: pluginsStep(machine, reference, view),
      settings: settingsStep(machine, reference),
      alerts: alertsStep(listed, targetHealth, referenceHealth),
      tools: toolsStep(machine, reference, toolchain),
      projects: projectsStep(machine, reference, projects),
      checks: checksStep(machine),
    };
  }, [machine, machines, reference, targetHealth, healthUnread, referenceHealth, assignments, requests, usageError, now, repoPath, repo, repoError, registry, registryError, view, listed, toolchain, projects, latest]);

  const states = steps ? STEP_ORDER.map((id) => ({ id, state: steps[id].state })) : [];
  const progress = checklistProgress(states.map((entry) => entry.state));
  const firstToDo = firstOpen(states);
  // Until a step is opened or closed by hand, the first with something to do is open.
  const autoIds: StepId[] = firstToDo ? [firstToDo] : [];
  const openIds = openState?.target === target ? openState.ids : autoIds;
  const toggle = (id: StepId) => setOpenState((current) => {
    const ids = current?.target === target ? current.ids : autoIds;
    return { target, ids: ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id] };
  });

  const [addingThis, setAddingThis] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Why this Mac couldn't be added is about the machine it was tried for.
  useEffect(() => setAddingThis(null), [target]);
  /** Lists this Mac, so its agents can be updated and the reporter set up from here. */
  const addThisMac = async () => {
    if (!machine) return;
    setAddingThis('busy');
    try {
      await saveMachineHosts([{ machine: machine.machine, endpoint: 'localhost', port: 22, enabled: true, source: '' }]);
      setAddingThis(null);
      onReload();
      void loadHealth();
    } catch (error) {
      setAddingThis(t('setup.checklist.connect.addFailed', { error: String(error) }));
    }
  };

  const others = machines.filter((entry) => entry.machine !== target);
  const reviewedMachine = review ? machine : null;
  const skillsPlan = steps?.skills;
  const skillsViewNow = useMemo(() => (machine && review === 'skills' ? skillsView(machine) : null), [machine, review]);

  const body = (id: StepId): ReactNode => {
    if (!steps || !machine) return null;
    const name = machine.machine;
    const ref = referenceName ? <MachinePill name={referenceName} size="md" /> : '';
    const pill = <MachinePill name={name} size="md" />;
    switch (id) {
      case 'connect': {
        const step = steps.connect;
        const host = targetHealth?.host ?? null;
        return (
          <>
            {step.why === 'down' || step.why === 'connecting' ? (
              <>
                <p className="text-muted-foreground">{t('setup.checklist.connect.hint')}</p>
                {host?.endpoint ? <CommandLine command={`ssh${host.port !== 22 ? ` -p ${host.port}` : ''} ${shellWord(host.endpoint)} true`} /> : null}
                {targetHealth && step.why === 'down' ? (() => {
                  const problem = healthProblem(targetHealth, t);
                  return problem ? <Actions><FixMenu machine={name} item={targetHealth} problem={problem} /></Actions> : null;
                })() : null}
              </>
            ) : null}
            {!listed ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-muted-foreground">{t('setup.checklist.connect.notListed')}</p>
                <Button variant="outline" size="xs" disabled={addingThis === 'busy'} onClick={() => void addThisMac()}>
                  {addingThis === 'busy' ? <Spinner /> : <Plus />}
                  {t('setup.checklist.connect.addThis')}
                </Button>
              </div>
            ) : null}
            {addingThis && addingThis !== 'busy' ? <p className="text-error-foreground" role="status">{addingThis}</p> : null}
            <Actions>
              {/* With no host there's nothing to read again until one is added. */}
              {step.why === 'noHost' ? (
                <Button variant="outline" size="xs" onClick={() => onNavigate({ kind: 'settings', page: 'machines' })}>{t('setup.checklist.openMachines')}</Button>
              ) : (
                <Button variant="outline" size="xs" disabled={machine.scanning || !machine.reachable} onClick={() => void scanSetup(name, false).catch(() => undefined)}>
                  <RefreshIcon refreshing={machine.scanning} />
                  {t('setup.checklist.rescan')}
                </Button>
              )}
            </Actions>
          </>
        );
      }
      case 'agents':
        return (
          <div className="flex flex-col divide-y divide-border/40 rounded-lg border border-border/50">
            {steps.agents.agents.map((fact) => (
              <AgentLine key={fact.agent} fact={fact} machine={name} health={listed ? targetHealth : null} listed={listed} />
            ))}
          </div>
        );
      case 'proxy': {
        const step = steps.proxy;
        return (
          <>
            {step.keys.length ? (
              <p className="text-muted-foreground">{t('setup.checklist.proxy.keys', { keys: step.keys.map((key) => key.label || key.api_key_hash.slice(0, 10)).join(', ') })}</p>
            ) : null}
            {step.why === 'noKey' ? <p className="text-muted-foreground">{t('setup.checklist.proxy.noKeyHint')}</p> : null}
            {step.why === 'quiet' ? <p className="text-muted-foreground">{t('setup.checklist.proxy.quietHint')}</p> : null}
            {step.settings.length ? (
              <>
                <p className="text-muted-foreground">{tRich('setup.checklist.proxy.settingsHint', { reference: ref, machine: pill })}</p>
                <ItemList
                  items={step.settings.map((setting) => (
                    <span key={setting.home}>
                      <span className="text-foreground">{homeLabel(setting.home)}</span>
                      <span className="ms-2 font-mono text-xs text-muted-foreground">{setting.names.join(', ')}</span>
                    </span>
                  ))}
                />
              </>
            ) : null}
            <Actions>
              {step.state !== 'done' ? (
                <Button size="xs" onClick={() => setConnecting(true)}>{t('home.start.agent.action')}</Button>
              ) : null}
              {step.why === 'noKey' ? (
                <Button variant="outline" size="xs" onClick={() => onNavigate({ kind: 'settings', page: 'machines' })}>{t('setup.checklist.openMachines')}</Button>
              ) : null}
              <Button variant="outline" size="xs" disabled={usageLoading} onClick={() => void loadUsage()}>
                <RefreshIcon refreshing={usageLoading} />
                {t('setup.checklist.proxy.again')}
              </Button>
            </Actions>
          </>
        );
      }
      case 'repo': {
        const step = steps.repo;
        return (
          <>
            {step.why === 'noRepo' ? <p className="text-muted-foreground">{t('setup.checklist.repo.noRepoHint')}</p> : null}
            {step.counts?.noHome ? (
              <p className="text-muted-foreground">{plural(step.counts.noHome, 'setup.checklist.repo.noHome.one', 'setup.checklist.repo.noHome.other', t)}</p>
            ) : null}
            <Actions>
              {step.why === 'behind' && repo?.head ? <Button size="xs" onClick={() => setReview('repo')}>{t('setup.checklist.review')}</Button> : null}
              <Button variant="outline" size="xs" onClick={() => onOpenTab('repo', name)}>{t('setup.checklist.open.repo')}</Button>
            </Actions>
          </>
        );
      }
      case 'skills': {
        const step = steps.skills;
        return (
          <>
            {step.plan.length ? (
              <ItemList
                items={step.plan.map((change) => (
                  <span key={`${change.cell.home.path}\u0000${change.row.name}`}>
                    <span className="font-mono text-xs text-foreground">{change.row.name}</span>
                    <span className="ms-2 text-muted-foreground">
                      {t(SKILL_ACTION[change.action], { home: homeLabel(homeKey(change.cell.home)) })}
                    </span>
                  </span>
                ))}
              />
            ) : null}
            {step.notHere.length ? (
              <p className="text-muted-foreground">
                {tRich('setup.checklist.skills.notHereHint', { skills: step.notHere.join(', '), machine: pill, reference: ref })}
              </p>
            ) : null}
            <Actions>
              {step.plan.length ? <Button size="xs" onClick={() => setReview('skills')}>{t('setup.checklist.review')}</Button> : null}
              <Button variant="outline" size="xs" onClick={() => onOpenTab('skills', name)}>{t('setup.checklist.open.skills')}</Button>
            </Actions>
          </>
        );
      }
      case 'mcp': {
        const step = steps.mcp;
        return (
          <>
            {step.why === 'noRepo' ? <p className="text-muted-foreground">{t('setup.checklist.repo.noRepoHint')}</p> : null}
            {step.plan.length ? (
              <ItemList
                items={step.plan.map((change) => (
                  <span key={`${change.home.path}\u0000${change.name}`}>
                    <span className="font-mono text-xs text-foreground">{change.name}</span>
                    <span className="ms-2 text-muted-foreground">
                      {t(change.action === 'update' ? 'setup.checklist.mcp.action.update' : 'setup.checklist.mcp.action.add', { home: homeLabel(homeKey(change.home)) })}
                    </span>
                  </span>
                ))}
              />
            ) : null}
            {step.blocked ? <p className="text-warning-foreground">{plural(step.blocked, 'setup.checklist.mcp.blocked.one', 'setup.checklist.mcp.blocked.other', t)}</p> : null}
            <Actions>
              {step.plan.length ? <Button size="xs" onClick={() => setReview('mcp')}>{t('setup.checklist.review')}</Button> : null}
              <Button variant="outline" size="xs" onClick={() => onOpenTab(step.why === 'noRepo' ? 'repo' : 'plugins', name)}>
                {t(step.why === 'noRepo' ? 'setup.checklist.open.repo' : 'setup.checklist.open.plugins')}
              </Button>
            </Actions>
          </>
        );
      }
      case 'plugins': {
        const step = steps.plugins;
        return (
          <>
            {step.plan.length ? (
              <ItemList
                items={step.plan.map((change, index) => (
                  <span key={`${change.home.path}\u0000${change.action}\u0000${change.target}\u0000${index}`}>
                    <span className="font-mono text-xs text-foreground">{change.target}</span>
                    <span className="ms-2 text-muted-foreground">{t(PLUGIN_ACTION[change.action], { home: homeLabel(homeKey(change.home)) })}</span>
                  </span>
                ))}
              />
            ) : null}
            {step.cantInstall.length ? (
              <p className="text-muted-foreground">{tRich('setup.checklist.plugins.cantInstall', { plugins: step.cantInstall.join(', '), reference: ref })}</p>
            ) : null}
            <Actions>
              {step.plan.length ? <Button size="xs" onClick={() => setReview('plugins')}>{t('setup.checklist.review')}</Button> : null}
              <Button variant="outline" size="xs" onClick={() => onOpenTab('plugins', name)}>{t('setup.checklist.open.plugins')}</Button>
            </Actions>
          </>
        );
      }
      case 'settings': {
        const step = steps.settings;
        const settingText = (diff: (typeof step.missing)[number]) => {
          const kind = KIND_LABEL[diff.kind];
          return `${diff.name} (${[kind ? t(kind) : diff.kind, homeLabel(diff.home)].join(', ')})`;
        };
        const line = (diff: (typeof step.missing)[number]) => {
          const kind = KIND_LABEL[diff.kind];
          return (
            <span key={`${diff.home}\u0000${diff.kind}\u0000${diff.name}`}>
              <span className="font-mono text-xs text-foreground">{diff.name}</span>
              <span className="ms-2 text-muted-foreground">{[kind ? t(kind) : diff.kind, homeLabel(diff.home)].join(' · ')}</span>
            </span>
          );
        };
        return (
          <>
            {step.missing.length ? (
              <>
                <p className="text-muted-foreground">{tRich('setup.checklist.settings.missingHead', { reference: ref })}</p>
                <ItemList items={step.missing.map(line)} />
              </>
            ) : null}
            {step.different.length ? (
              <>
                <p className="text-muted-foreground">{t('setup.checklist.settings.differentHead')}</p>
                <ItemList items={step.different.map(line)} />
              </>
            ) : null}
            {step.missing.length || step.different.length ? <p className="text-muted-foreground">{tRich('setup.checklist.settings.hint', { reference: ref })}</p> : null}
            {referenceName && (step.missing.length || step.different.length) ? (
              <Actions>
                <Button variant="outline" size="xs" onClick={() => onCompareSettings(referenceName, (step.missing[0] ?? step.different[0])?.home ?? null)}>
                  {tRich('setup.checklist.settings.compare', { reference: ref })}
                </Button>
                <FixMenu
                  machine={name}
                  item={targetHealth}
                  problem={settingsInLineProblem({ reference: referenceName, missing: step.missing.map(settingText), different: step.different.map(settingText) }, t)}
                />
              </Actions>
            ) : null}
          </>
        );
      }
      case 'alerts': {
        const step = steps.alerts;
        if (step.why === 'notListed') return <p className="text-muted-foreground">{t('setup.checklist.connect.notListed')}</p>;
        return targetHealth ? <div className="rounded-lg border border-border/50 px-3 py-1"><MachineReporterRow item={targetHealth} /></div> : null;
      }
      case 'tools': {
        const step = steps.tools;
        return (
          <>
            {step.missing.length ? <p className="text-foreground/90">{tRich('setup.checklist.tools.missingList', { tools: step.missing.map((tool) => toolLabel(tool, t)).join(', '), reference: ref })}</p> : null}
            {step.behind.length ? (
              <p className="text-muted-foreground">
                {t('setup.checklist.tools.behind', { tools: step.behind.map((entry) => t('setup.checklist.tools.behindItem', { tool: toolLabel(entry.tool, t), version: entry.version, newest: entry.newest })).join(', ') })}
              </p>
            ) : null}
            {step.why === 'checked' && reference && !step.referenceScanned ? (
              <p className="text-muted-foreground">
                {step.referenceError
                  ? tRich('setup.checklist.tools.referenceFailedHint', { reference: ref, error: step.referenceError })
                  : tRich('setup.checklist.tools.referenceNotScanned', { reference: ref })}
              </p>
            ) : null}
            <Actions>
              <Button variant="outline" size="xs" disabled={step.why === 'scanning' || !machine.reachable} onClick={() => void scanToolchain(name).catch(() => undefined)}>
                <RefreshIcon refreshing={step.why === 'scanning'} />
                {t('setup.checklist.lookAgain')}
              </Button>
              <Button variant="outline" size="xs" onClick={() => onOpenTab('toolchain', name)}>{t('setup.checklist.open.toolchain')}</Button>
              {step.missing.length || step.behind.length ? (
                <FixMenu
                  machine={name}
                  item={targetHealth}
                  problem={toolsInLineProblem({
                    reference: referenceName,
                    missing: step.missing.map((tool) => toolLabel(tool, t)),
                    behind: step.behind.map((entry) => t('setup.checklist.tools.behindItem', { tool: toolLabel(entry.tool, t), version: entry.version, newest: entry.newest })),
                  }, t)}
                />
              ) : null}
            </Actions>
          </>
        );
      }
      case 'projects': {
        const step = steps.projects;
        const scanning = projects?.some((entry) => entry.machine === name && entry.scanning) ?? false;
        return (
          <>
            {step.missing.length ? (
              <>
                <p className="text-muted-foreground">{tRich('setup.checklist.projects.hint', { reference: ref, machine: pill })}</p>
                <div className="flex flex-col gap-1.5">
                  {step.missing.slice(0, LIST_MAX).map((project) => (
                    project.command ? (
                      <CommandLine key={project.key} command={project.command} />
                    ) : (
                      <p key={project.key} className="text-muted-foreground">
                        {t('setup.checklist.projects.alias', { remote: project.remote, path: project.path })}
                      </p>
                    )
                  ))}
                  {step.missing.length > LIST_MAX ? <p className="text-muted-foreground">{t('setup.checklist.more', { count: step.missing.length - LIST_MAX })}</p> : null}
                </div>
              </>
            ) : null}
            <Actions>
              <Button variant="outline" size="xs" disabled={scanning || !machine.reachable} onClick={() => void scanProjects(name).catch(() => undefined)}>
                <RefreshIcon refreshing={scanning} />
                {t('setup.checklist.lookAgain')}
              </Button>
              <Button variant="outline" size="xs" onClick={() => onOpenTab('projects', name)}>{t('setup.checklist.open.projects')}</Button>
              {step.missing.length && referenceName ? (
                <FixMenu
                  machine={name}
                  item={targetHealth}
                  problem={projectsInLineProblem({
                    reference: referenceName,
                    clones: step.missing.map((project) => project.command ?? t('setup.checklist.projects.alias', { remote: project.remote, path: project.path })),
                  }, t)}
                />
              ) : null}
            </Actions>
          </>
        );
      }
      case 'checks':
        return steps.checks.checks.length ? (
          <SetupChecks checks={steps.checks.checks} machines={[name]} homeLabel={homeLabel} onShow={onShowCheck} onCompare={onCompareCheck} />
        ) : null;
      default:
        return null;
    }
  };

  const inWords: Writer<string> = { machine: (name) => name, say: t, join: (parts) => parts.join(' · ') };
  const withPills: Writer<ReactNode> = {
    machine: (name) => (name ? <MachinePill name={name} size="md" /> : ''),
    say: (key, values = {}) => tRich(key, values),
    join: (parts) => parts.map((part, index) => <Fragment key={index}>{index ? ' · ' : null}{part}</Fragment>),
  };
  const summary = <T,>(id: StepId, { machine: named, say, join }: Writer<T>): T | '' => {
    if (!steps || !machine) return '';
    const name = named(machine.machine);
    const ref = named(referenceName ?? '');
    const plural = (count: number, one: MessageKey, other: MessageKey, values: Record<string, string | number | T> = {}) =>
      say(count === 1 ? one : other, { count: formatCount(count), ...values });
    // A step waiting on a machine's read, or stuck on one that failed.
    const unread = (state: StepState, both: boolean) =>
      state === 'unknown' ? say('setup.checklist.readFailed') : say(both ? 'setup.checklist.waitingBoth' : 'setup.checklist.notRead');
    switch (id) {
      case 'connect': {
        const step = steps.connect;
        switch (step.why) {
          case 'ok': return say('setup.checklist.connect.ok', { time: machine.scannedAt !== null ? formatAgo(machine.scannedAt, now) : '' });
          case 'noHost': return say('setup.checklist.connect.noHost');
          case 'connecting': return say('setup.checklist.connect.connecting');
          case 'healthUnread': return say('setup.checklist.connect.healthUnread');
          case 'down': return say('setup.checklist.connect.down', { error: step.error ?? '' });
          case 'reading': return say('setup.checklist.connect.reading');
          case 'notRead': return say('setup.checklist.connect.notRead');
          default: return say('setup.checklist.connect.scanFailed', { error: step.error ?? '' });
        }
      }
      case 'agents': {
        const step = steps.agents;
        if (!step.agents.length) return unread(step.state, false);
        return join(step.agents.filter((fact) => fact.state !== 'notNeeded').map((fact) => agentSummary(fact, t, say)));
      }
      case 'proxy': {
        const step = steps.proxy;
        switch (step.why) {
          case 'seen': return plural(step.requests, 'setup.checklist.proxy.seen.one', 'setup.checklist.proxy.seen.other', { time: step.lastRequestMs !== null ? formatAgo(step.lastRequestMs, now) : '' });
          case 'noKey': return say('setup.checklist.proxy.noKey');
          case 'quiet': return say('setup.checklist.proxy.quiet');
          case 'loading': return say('setup.checklist.proxy.loading');
          default: return say('setup.checklist.proxy.failed', { error: step.error ?? '' });
        }
      }
      case 'repo': {
        const step = steps.repo;
        switch (step.why) {
          case 'noRepo': return say('setup.checklist.repo.noRepo');
          case 'loading': return say('setup.checklist.repo.loading');
          case 'failed': return say('setup.checklist.repo.failed', { error: step.error ?? '' });
          case 'noCommits': return say('setup.checklist.repo.noCommits');
          case 'notRead': return unread(step.state, false);
          case 'inStep': return say('setup.checklist.repo.inStep');
          default: {
            const count = (step.counts?.add ?? 0) + (step.counts?.update ?? 0);
            return plural(count, 'setup.checklist.repo.behind.one', 'setup.checklist.repo.behind.other');
          }
        }
      }
      case 'skills': {
        const step = steps.skills;
        if (step.state === 'waiting' || step.state === 'unknown') return unread(step.state, reference !== null);
        const parts: T[] = [];
        if (step.links) parts.push(plural(step.links, 'setup.checklist.skills.links.one', 'setup.checklist.skills.links.other'));
        if (step.plan.length > step.links) parts.push(plural(step.plan.length - step.links, 'setup.checklist.skills.tidy.one', 'setup.checklist.skills.tidy.other'));
        if (step.notHere.length) parts.push(plural(step.notHere.length, 'setup.checklist.skills.notHere.one', 'setup.checklist.skills.notHere.other', { reference: ref }));
        return parts.length ? join(parts) : reference ? say('setup.checklist.skills.done', { reference: ref }) : say('setup.checklist.skills.doneAlone');
      }
      case 'mcp': {
        const step = steps.mcp;
        switch (step.why) {
          case 'noRepo': return say('setup.checklist.repo.noRepo');
          case 'loading': return say('setup.checklist.mcp.loading');
          case 'failed': return say('setup.checklist.mcp.failed', { error: step.error ?? '' });
          case 'noFile': return say('setup.checklist.mcp.noFile');
          case 'broken': return say('setup.checklist.mcp.broken', { error: step.error ?? '' });
          case 'notRead': return unread(step.state, false);
          case 'offline': return say('setup.checklist.offline');
          case 'inStep': return say('setup.checklist.mcp.inStep');
          default:
            return step.plan.length
              ? plural(step.plan.length, 'setup.checklist.mcp.todo.one', 'setup.checklist.mcp.todo.other')
              : plural(step.blocked, 'setup.checklist.mcp.blocked.one', 'setup.checklist.mcp.blocked.other');
        }
      }
      case 'plugins': {
        const step = steps.plugins;
        if (step.state === 'skip') return say('setup.checklist.noReference');
        if (step.offline) return say('setup.checklist.offline');
        if (step.state === 'waiting' || step.state === 'unknown') return unread(step.state, true);
        const parts: T[] = [];
        if (step.plan.length) parts.push(plural(step.plan.length, 'setup.checklist.plugins.todo.one', 'setup.checklist.plugins.todo.other', { reference: ref }));
        if (step.cantInstall.length) parts.push(plural(step.cantInstall.length, 'setup.checklist.plugins.cant.one', 'setup.checklist.plugins.cant.other'));
        return parts.length ? join(parts) : say('setup.checklist.plugins.done', { reference: ref });
      }
      case 'settings': {
        const step = steps.settings;
        if (step.state === 'skip') return say('setup.checklist.noReference');
        if (step.state === 'waiting' || step.state === 'unknown') return unread(step.state, true);
        if (step.missing.length) return plural(step.missing.length, 'setup.checklist.settings.todo.one', 'setup.checklist.settings.todo.other', { reference: ref });
        if (step.different.length) return plural(step.different.length, 'setup.checklist.settings.different.one', 'setup.checklist.settings.different.other', { reference: ref });
        return say('setup.checklist.settings.done', { reference: ref });
      }
      case 'alerts': {
        const step = steps.alerts;
        switch (step.why) {
          case 'notListed': return say('setup.checklist.alerts.notListed');
          case 'loading': return say('setup.checklist.alerts.loading');
          case 'down': return say('setup.checklist.alerts.down');
          case 'on': return say('setup.checklist.alerts.on');
          case 'partly': return say('setup.checklist.alerts.partly');
          default:
            return step.onReference === true
              ? say('setup.checklist.alerts.off', { reference: ref })
              : step.onReference === false ? say('setup.checklist.alerts.offBoth', { reference: ref }) : say('setup.checklist.alerts.offUnknown');
        }
      }
      case 'tools': {
        const step = steps.tools;
        switch (step.why) {
          case 'loading': return say('setup.checklist.tools.loading');
          case 'notScanned': return say('setup.checklist.tools.notScanned');
          case 'scanning': return say('setup.checklist.tools.scanning');
          case 'failed': return say('setup.checklist.tools.failed', { error: step.error ?? '' });
          default: {
            const parts: T[] = [];
            if (step.missing.length) parts.push(say('setup.checklist.tools.missing', { tools: step.missing.map((tool) => toolLabel(tool, t)).join(', ') }));
            if (step.projects) parts.push(plural(step.projects, 'setup.checklist.tools.projects.one', 'setup.checklist.tools.projects.other'));
            if (parts.length) return join(parts);
            if (step.state === 'waiting') return say('setup.checklist.tools.referenceWaiting', { reference: ref });
            if (step.state === 'unknown') return say('setup.checklist.tools.referenceFailed', { reference: ref });
            return step.referenceScanned ? say('setup.checklist.tools.done', { reference: ref }) : say('setup.checklist.tools.doneAlone');
          }
        }
      }
      case 'projects': {
        const step = steps.projects;
        if (step.state === 'skip') return say('setup.checklist.noReference');
        switch (step.why) {
          case 'loading': return say('setup.checklist.projects.loading');
          case 'notScanned': return say('setup.checklist.projects.notScanned');
          case 'referenceNotScanned': return say('setup.checklist.projects.referenceNotScanned', { reference: ref });
          case 'failed': return say('setup.checklist.projects.failed', { error: step.error ?? '' });
          case 'referenceFailed': return say('setup.checklist.projects.referenceFailed', { reference: ref, error: step.error ?? '' });
          default:
            return step.missing.length
              ? plural(step.missing.length, 'setup.checklist.projects.todo.one', 'setup.checklist.projects.todo.other', { reference: ref })
              : say('setup.checklist.projects.done', { reference: ref, machine: name });
        }
      }
      case 'checks': {
        const step = steps.checks;
        if (step.state === 'waiting' || step.state === 'unknown') return unread(step.state, false);
        return step.checks.length
          ? plural(step.checks.length, 'setup.checklist.checks.todo.one', 'setup.checklist.checks.todo.other')
          : say('setup.checklist.checks.done');
      }
      default:
        return '';
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-xs/5">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <ListChecks className="size-4 shrink-0 text-icon-muted" aria-hidden="true" />
          <span className="min-w-0">{tRich('machine.checklist.title', { machine: <MachinePill name={target} size="md" /> })}</span>
        </h2>
        {others.length ? (
          <Select value={referenceName ?? ''} onValueChange={(value) => { if (value) chooseReference(String(value)); }}>
            <SelectTrigger size="sm" className="w-auto min-w-44" aria-label={t('setup.checklist.like')}>
              <SelectValue>{tRich('setup.checklist.likeValue', { machine: referenceName ? <MachinePill name={referenceName} /> : '' })}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start">
              {others.map((entry) => <SelectItem key={entry.machine} value={entry.machine}><MachinePill name={entry.machine} /></SelectItem>)}
            </SelectPopup>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">{t('setup.checklist.noOther')}</span>
        )}
        <div className="ms-auto flex items-center gap-4">
          {steps ? (
            <div className="flex w-48 flex-col gap-1.5">
              <span className="text-xs tabular-nums text-muted-foreground">{t('setup.checklist.progress', { done: progress.done, total: progress.total })}</span>
              <Progress
                value={progress.total ? (progress.done / progress.total) * 100 : 0}
                tone={progress.total && progress.done === progress.total ? 'success' : 'primary'}
                aria-label={t('setup.checklist.progress', { done: progress.done, total: progress.total })}
              />
            </div>
          ) : null}
          <Button variant="outline" size="sm" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
            <ChevronDown className={cn('transition-transform', !folded && 'rotate-180')} />
            {t(folded ? 'machine.checklist.show' : 'machine.checklist.hide')}
          </Button>
        </div>
      </div>
      {notice ? <p className="-mt-2 text-xs text-muted-foreground" role="status">{notice}</p> : null}

      {steps && machine && !folded ? (
        <ol className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50" aria-label={t('setup.checklist.stepsLabel', { machine: machine.machine })}>
          {STEP_ORDER.map((id, index) => {
            // A step waiting on a machine with no host can only wait for one, and nothing it offers would work yet.
            const hostless = id !== 'connect' && waitsForHost(steps.connect, steps[id]);
            const content = hostless ? null : body(id);
            return (
              <StepRow
                key={id}
                number={index + 1}
                state={steps[id].state}
                title={t(STEP_TITLE[id])}
                summary={hostless ? t('setup.checklist.waitingHost') : summary(id, withPills)}
                summaryText={hostless ? t('setup.checklist.waitingHost') : summary(id, inWords)}
                open={openIds.includes(id)}
                onToggle={() => toggle(id)}
              >
                {content}
              </StepRow>
            );
          })}
        </ol>
      ) : null}

      {repo?.head ? (
        <SyncReviewDialog
          repo={repo}
          machine={review === 'repo' ? reviewedMachine : null}
          onClose={() => setReview(null)}
          onApplied={() => undefined}
          onRepo={setRepo}
        />
      ) : null}
      <SkillReviewDialog
        open={review === 'skills'}
        machine={review === 'skills' ? reviewedMachine : null}
        view={skillsViewNow}
        pending={skillsPlan?.pending ?? {}}
        planned={skillsPlan?.plan ?? []}
        homeLabel={homeLabel}
        onClose={() => setReview(null)}
        onApplied={(outcome) => {
          setReview(null);
          const named = <MachinePill name={target} size="sm" />;
          setNotice(outcome.failed.length
            ? tRich('setup.checklist.skills.appliedSome', { machine: named, count: outcome.failed.length })
            : tRich('setup.checklist.skills.applied', { machine: named }));
        }}
      />
      <ExtensionsReviewDialog
        open={review === 'mcp' || review === 'plugins'}
        planned={review === 'plugins' && steps?.plugins.plan.length ? new Map([[target, steps.plugins.plan]]) : new Map()}
        plannedServers={review === 'mcp' && steps?.mcp.plan.length ? new Map([[target, steps.mcp.plan]]) : new Map()}
        repo={repoPath}
        commit={registry?.commit ?? null}
        machines={machines}
        homeLabel={homeLabel}
        onClose={() => setReview(null)}
        onApplied={() => undefined}
      />
      <ConnectAgentDialog open={connecting} onClose={() => setConnecting(false)} from={machine?.local === false ? 'other' : 'here'} onNavigate={onNavigate} />
    </div>
  );
}

function agentSummary<T>(fact: AgentFact, t: Translate, say: Writer<T>['say']): T {
  const agent = t(AGENT_NAME[fact.agent]);
  switch (fact.state) {
    case 'missing': return say('setup.checklist.agents.summary.missing', { agent });
    case 'noHome': return say('setup.checklist.agents.summary.noHome', { agent });
    case 'behind': return say('setup.checklist.agents.summary.behind', { agent, version: fact.install?.version ?? '' });
    case 'unknown': return say('setup.checklist.agents.summary.unknown', { agent });
    default: return say('setup.checklist.agents.summary.ok', { agent, version: fact.install?.version ?? '' });
  }
}

/** One agent on the machine: its version, and what to do about it. */
function AgentLine({ fact, machine, health, listed }: { fact: AgentFact; machine: string; health: MachineHealth | null; listed: boolean }) {
  const { t, tRich } = useI18n();
  const agent = t(AGENT_NAME[fact.agent]);
  const pill = <MachinePill name={machine} size="md" />;
  let detail: ReactNode;
  switch (fact.state) {
    case 'missing': detail = tRich('setup.checklist.agents.missing', { machine: pill }); break;
    case 'noHome': detail = tRich('setup.checklist.agents.noHome', { machine: pill, home: fact.agent === 'claude' ? '~/.claude' : '~/.codex' }); break;
    case 'behind':
      detail = fact.newest?.machine
        ? tRich('setup.checklist.agents.behind', { newest: fact.newest.version, machine: <MachinePill name={fact.newest.machine} size="md" /> })
        : t('setup.checklist.agents.behindLatest', { newest: fact.newest?.version ?? '' });
      break;
    case 'unknown': detail = t('setup.checklist.agents.unknown'); break;
    case 'notNeeded': detail = t('setup.checklist.agents.notNeeded'); break;
    default: detail = t('setup.checklist.agents.ok');
  }
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-24 shrink-0 font-medium text-foreground">{agent}</span>
        {fact.install ? (
          <span className={cn('tabular-nums', fact.install.version ? 'text-foreground' : 'text-muted-foreground')}>
            {fact.install.version ?? t('machines.agents.unknownVersion')}
          </span>
        ) : null}
        <span className={cn('min-w-0 flex-1', fact.state === 'ok' || fact.state === 'notNeeded' ? 'text-muted-foreground' : 'text-warning-foreground')}>{detail}</span>
        {fact.state === 'behind' ? (
          health ? <AgentUpdate item={health} agent={fact.agent} /> : !listed ? <span className="text-xs text-muted-foreground">{t('setup.checklist.agents.needsList')}</span> : null
        ) : null}
      </div>
      {fact.state === 'missing' ? (
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1"><CommandLine command={fact.command} /></div>
          <FixMenu machine={machine} item={health} problem={agentMissingProblem({ agent: fact.agent, command: fact.command }, t)} />
        </div>
      ) : null}
    </div>
  );
}

/** The Machines page's update, from the checklist: the way the agent was installed there, once its user says so. */
function AgentUpdate({ item, agent }: { item: MachineHealth; agent: AgentKind }) {
  const { t } = useI18n();
  const { update, busy, outcomes } = useAgentUpdate(item);
  const reachable = item.status !== 'unreachable' && item.status !== 'pending';
  const outcome = outcomes[agent];
  return (
    <>
      <Button
        variant="outline"
        size="xs"
        disabled={busy(agent) || !item.agents[agent]}
        onClick={() => void update(agent)}
        disabledReason={reachable ? undefined : t('machines.agents.updateUnreachable')}
      >
        {busy(agent) ? <Spinner /> : <ArrowUpCircle />}
        {busy(agent) ? t('machines.agents.updating') : t('machines.agents.update')}
      </Button>
      {outcome ? <div className="basis-full"><UpdateOutcomeView outcome={outcome} fix={{ machine: item.machine, agent, item }} /></div> : null}
    </>
  );
}

function StepRow({ number, state, title, summary, summaryText, open, onToggle, children }: {
  number: number;
  state: StepState;
  title: string;
  summary: ReactNode;
  /** The summary in words, for its tooltip. */
  summaryText: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Collapsible render={<li />} open={open} onOpenChange={onToggle}>
      <CollapsibleTrigger
        chevron="end"
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none dark:hover:bg-input/16"
      >
        <StepMark number={number} state={state} />
        <span className="sr-only">{t(STATE_TEXT[state])}</span>
        <span className="w-56 shrink-0 truncate text-sm font-medium text-foreground">{title}</span>
        <span className={cn('min-w-0 flex-1 truncate text-sm', state === 'todo' ? 'text-warning-foreground' : 'text-muted-foreground')} title={summaryText}>{summary}</span>
      </CollapsibleTrigger>
      {children ? (
        <CollapsiblePanel>
          <div className="flex flex-col gap-2.5 pe-4 pb-4 ps-[3.25rem] text-sm">{children}</div>
        </CollapsiblePanel>
      ) : null}
    </Collapsible>
  );
}

/** A step's number, or a tick once it's done. */
function StepMark({ number, state }: { number: number; state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success-foreground" aria-hidden="true">
        <Check className="size-3.5" />
      </span>
    );
  }
  if (state === 'waiting') {
    return <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true"><Spinner className="size-3.5 text-muted-foreground" /></span>;
  }
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs tabular-nums',
        state === 'todo' ? 'border-warning/60 bg-warning/10 text-warning-foreground' : 'border-border text-muted-foreground',
      )}
      aria-hidden="true"
    >
      {state === 'skip' ? '–' : number}
    </span>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 pt-0.5">{children}</div>;
}

/** A few of a list, then how many more. */
function ItemList({ items }: { items: ReactNode[] }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-1">
      {items.slice(0, LIST_MAX).map((entry, index) => <li key={index} className="min-w-0 truncate">{entry}</li>)}
      {items.length > LIST_MAX ? <li className="text-muted-foreground">{t('setup.checklist.more', { count: items.length - LIST_MAX })}</li> : null}
    </ul>
  );
}
