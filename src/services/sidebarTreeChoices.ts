import type { MainPageId } from '../navigation';
import { savedStore } from './savedStore';
import { arrivedChoices, parseOpenChoices, type OpenChoices } from './sidebarTree';

/** Which of the tree's groups were opened or closed by hand, kept in the window's storage across restarts. */
const choices = savedStore<OpenChoices>({ key: 'arbor.sidebar.tree.v1', parse: parseOpenChoices, fallback: {}, place: 'window' });

export const useOpenChoices = choices.useValue;

export const setGroupOpen = (page: MainPageId, open: boolean) => choices.set({ ...choices.get(), [page]: open });

export const arriveAtPage = (page: MainPageId) => choices.set(arrivedChoices(choices.get(), page));
