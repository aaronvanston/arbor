import type { MessageKey } from '../i18n/resources';
import type { MachineFacts, MachineHealth } from '../native/types';

/** The shape a machine's icon draws. Anything that isn't a Mac is a server. */
export type MachineKind = 'laptop' | 'macMini' | 'macStudio' | 'imac' | 'macPro' | 'mac' | 'server';

export type MachineIdentity = {
  kind: MachineKind;
  /** The product, like MacBook Pro; null when there's nothing to say beyond the OS it runs. */
  label: MessageKey | null;
  /** What a Mac on Apple silicon calls itself, like "MacBook Pro (14-inch, 2024)". */
  productName: string | null;
  /** A Mac's model identifier, like "Mac16,8". */
  modelId: string | null;
};

type Family = 'macbookPro' | 'macbookAir' | 'macbook' | 'macMini' | 'macStudio' | 'imac' | 'imacPro' | 'macPro';

const FAMILIES: Record<Family, { kind: MachineKind; label: MessageKey }> = {
  macbookPro: { kind: 'laptop', label: 'machines.identity.macbookPro' },
  macbookAir: { kind: 'laptop', label: 'machines.identity.macbookAir' },
  macbook: { kind: 'laptop', label: 'machines.identity.macbook' },
  macMini: { kind: 'macMini', label: 'machines.identity.macMini' },
  macStudio: { kind: 'macStudio', label: 'machines.identity.macStudio' },
  imac: { kind: 'imac', label: 'machines.identity.imac' },
  imacPro: { kind: 'imac', label: 'machines.identity.imacPro' },
  macPro: { kind: 'macPro', label: 'machines.identity.macPro' },
};

/**
 * Macs on Apple silicon from 2022 on share one `MacN,M` scheme that says nothing about the product, so they're looked
 * up here. Older ones name the product in the identifier itself (`MacBookPro18,3`, `Macmini9,1`), and a Mac this list
 * doesn't know yet still names itself in its product name.
 */
const APPLE_SILICON: Record<string, Family> = {
  'Mac13,1': 'macStudio',
  'Mac13,2': 'macStudio',
  'Mac14,2': 'macbookAir',
  'Mac14,3': 'macMini',
  'Mac14,5': 'macbookPro',
  'Mac14,6': 'macbookPro',
  'Mac14,7': 'macbookPro',
  'Mac14,8': 'macPro',
  'Mac14,9': 'macbookPro',
  'Mac14,10': 'macbookPro',
  'Mac14,12': 'macMini',
  'Mac14,13': 'macStudio',
  'Mac14,14': 'macStudio',
  'Mac14,15': 'macbookAir',
  'Mac15,3': 'macbookPro',
  'Mac15,4': 'imac',
  'Mac15,5': 'imac',
  'Mac15,6': 'macbookPro',
  'Mac15,7': 'macbookPro',
  'Mac15,8': 'macbookPro',
  'Mac15,9': 'macbookPro',
  'Mac15,10': 'macbookPro',
  'Mac15,11': 'macbookPro',
  'Mac15,12': 'macbookAir',
  'Mac15,13': 'macbookAir',
  'Mac15,14': 'macStudio',
  'Mac16,1': 'macbookPro',
  'Mac16,2': 'imac',
  'Mac16,3': 'imac',
  'Mac16,5': 'macbookPro',
  'Mac16,6': 'macbookPro',
  'Mac16,7': 'macbookPro',
  'Mac16,8': 'macbookPro',
  'Mac16,9': 'macStudio',
  'Mac16,10': 'macMini',
  'Mac16,11': 'macMini',
  'Mac16,12': 'macbookAir',
  'Mac16,13': 'macbookAir',
};

/** Longest first, so MacBook Pro isn't read as MacBook, or iMac Pro as iMac. */
const PREFIXES: [string, Family][] = [
  ['macbookpro', 'macbookPro'],
  ['macbookair', 'macbookAir'],
  ['macbook', 'macbook'],
  ['macmini', 'macMini'],
  ['macstudio', 'macStudio'],
  ['imacpro', 'imacPro'],
  ['imac', 'imac'],
  ['macpro', 'macPro'],
];

/** The family an older identifier (`MacBookAir10,1`) or a product name (`Mac mini (2024)`) starts with. */
function familyByName(name: string): Family | null {
  const compact = name.toLowerCase().replace(/\s+/g, '');
  return PREFIXES.find(([prefix]) => compact.startsWith(prefix))?.[1] ?? null;
}

/** What a machine is, from what its last sample said; null until it has answered once. */
export function machineIdentity(facts: Pick<MachineFacts, 'os' | 'model' | 'productName'> | null): MachineIdentity | null {
  if (!facts) return null;
  const modelId = facts.model.trim() || null;
  const productName = facts.productName.trim() || null;
  if (facts.os !== 'Darwin') {
    return { kind: 'server', label: facts.os === 'Linux' ? 'machines.identity.linux' : null, productName: null, modelId: null };
  }
  if (modelId?.startsWith('VirtualMac')) return { kind: 'server', label: 'machines.identity.virtualMac', productName, modelId };
  const family = (modelId ? APPLE_SILICON[modelId] ?? familyByName(modelId) : null) ?? (productName ? familyByName(productName) : null);
  const known = family ? FAMILIES[family] : { kind: 'mac' as const, label: 'machines.identity.mac' as const };
  return { ...known, productName, modelId };
}

/** Each sampled machine's identity, by name. */
export function identitiesByMachine(machines: Pick<MachineHealth, 'machine' | 'facts'>[]): Map<string, MachineIdentity> {
  const identities = new Map<string, MachineIdentity>();
  for (const item of machines) {
    const identity = machineIdentity(item.facts);
    if (identity) identities.set(item.machine, identity);
  }
  return identities;
}

/** The OS a machine runs and its version, with Darwin called macOS and a version that already names its OS left alone. */
export const osLabel = (os: string, version: string) => {
  const family = os === 'Darwin' ? 'macOS' : os;
  return version && version.toLowerCase().startsWith(family.toLowerCase()) ? version : [family, version].filter(Boolean).join(' ');
};
