import { t, type TranslationKey } from './i18n.js';

type ToolId =
  | 'home'
  | 'network-switcher'
  | 'split-routing'
  | 'wechat-auto-reply';

function componentForTool(toolId: ToolId): ToolboxComponentId | null {
  return toolId === 'home' ? null : toolId;
}

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
  {
    id: 'split-routing',
    label: 'splitRouting',
    navigationId: 'nav-split-routing',
    viewId: 'view-split-routing',
  },
  {
    id: 'wechat-auto-reply',
    label: 'wechatAutoReply',
    navigationId: 'nav-wechat-auto-reply',
    viewId: 'view-wechat-auto-reply',
  },
];

function showTool(toolId: ToolId): void {
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

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']+': Error:\s*/u,
    '',
  );
}

export function initializeToolNavigation(): () => void {
  const cleanups: Array<() => void> = [];
  const transitionStatus = document.getElementById('component-transition');
  if (!transitionStatus) throw new Error('The component transition status is missing.');
  let activeToolId: ToolId = 'home';
  let navigationInProgress = false;

  const navigate = async (toolId: ToolId): Promise<void> => {
    if (navigationInProgress || toolId === activeToolId) return;
    navigationInProgress = true;
    const currentView = document.getElementById(`view-${activeToolId}`);
    currentView?.setAttribute('aria-busy', 'true');
    const progressTimer = window.setTimeout(() => {
      transitionStatus.textContent = t('componentLeaving');
      transitionStatus.hidden = false;
    }, 150);
    for (const tool of TOOL_DEFINITIONS) {
      const navigation = document.getElementById(tool.navigationId);
      if (navigation instanceof HTMLButtonElement) navigation.disabled = true;
    }
    try {
      const currentComponent = componentForTool(activeToolId);
      if (currentComponent) {
        await window.cherryToolbox.app.leaveComponent(currentComponent);
      }
      activeToolId = toolId;
      showTool(toolId);
    } catch (error) {
      window.alert(
        t('componentLeaveFailed', { message: friendlyError(error) }),
      );
    } finally {
      window.clearTimeout(progressTimer);
      transitionStatus.hidden = true;
      transitionStatus.textContent = '';
      currentView?.removeAttribute('aria-busy');
      navigationInProgress = false;
      for (const tool of TOOL_DEFINITIONS) {
        const navigation = document.getElementById(tool.navigationId);
        if (navigation instanceof HTMLButtonElement) navigation.disabled = false;
      }
    }
  };

  for (const tool of TOOL_DEFINITIONS) {
    const navigation = document.getElementById(tool.navigationId);
    if (!(navigation instanceof HTMLButtonElement)) {
      throw new Error(`Navigation button #${tool.navigationId} is missing.`);
    }
    const listener = (): void => void navigate(tool.id);
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
    const listener = (): void => void navigate(tool.id);
    button.addEventListener('click', listener);
    cleanups.push(() => button.removeEventListener('click', listener));
  }

  showTool('home');
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
