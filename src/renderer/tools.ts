import { t, type TranslationKey } from './i18n.js';

type ToolId = 'home' | 'network-switcher';

interface ToolDefinition {
  id: ToolId;
  label: TranslationKey;
  navigationId: string;
  viewId: string;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    id: 'home',
    label: 'home',
    navigationId: 'nav-home',
    viewId: 'view-home',
  },
  {
    id: 'network-switcher',
    label: 'networkSwitcher',
    navigationId: 'nav-network-switcher',
    viewId: 'view-network-switcher',
  },
];

function activateTool(toolId: ToolId): void {
  for (const tool of TOOL_DEFINITIONS) {
    const active = tool.id === toolId;
    const navigation = document.getElementById(tool.navigationId);
    const view = document.getElementById(tool.viewId);
    if (!(navigation instanceof HTMLButtonElement) || !view) {
      throw new Error(`Tool UI for ${tool.id} is incomplete.`);
    }

    navigation.classList.toggle('is-active', active);
    navigation.setAttribute('aria-current', active ? 'page' : 'false');
    view.hidden = !active;
  }

  const activeTool = TOOL_DEFINITIONS.find((tool) => tool.id === toolId);
  if (activeTool) document.title = `Cherry Toolbox — ${t(activeTool.label)}`;
}

export function initializeToolNavigation(): () => void {
  const cleanups: Array<() => void> = [];

  for (const tool of TOOL_DEFINITIONS) {
    const navigation = document.getElementById(tool.navigationId);
    if (!(navigation instanceof HTMLButtonElement)) {
      throw new Error(`Navigation button #${tool.navigationId} is missing.`);
    }
    const listener = (): void => activateTool(tool.id);
    navigation.addEventListener('click', listener);
    cleanups.push(() => navigation.removeEventListener('click', listener));
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '[data-open-tool]',
  )) {
    const tool = TOOL_DEFINITIONS.find(
      (candidate) => candidate.id === button.dataset.openTool,
    );
    if (!tool) continue;
    const listener = (): void => activateTool(tool.id);
    button.addEventListener('click', listener);
    cleanups.push(() => button.removeEventListener('click', listener));
  }

  activateTool('home');
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
