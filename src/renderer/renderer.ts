import { applyTranslations, t } from './i18n.js';
import { initializeNetworkSwitcher } from './network-switcher.js';
import { initializeToolNavigation } from './tools.js';

const appVersion = document.getElementById('app-version');
if (!(appVersion instanceof HTMLSpanElement)) {
  throw new Error('Required element #app-version is missing.');
}

applyTranslations();
const stopNavigation = initializeToolNavigation();
const stopNetworkSwitcher = initializeNetworkSwitcher();

void window.cherryToolbox.app
  .getInfo()
  .then((info) => {
    appVersion.textContent = t('version', { version: info.version });
  })
  .catch(() => {
    appVersion.textContent = '';
  });

window.addEventListener(
  'beforeunload',
  () => {
    stopNavigation();
    stopNetworkSwitcher();
  },
  { once: true },
);
