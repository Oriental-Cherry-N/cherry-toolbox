export const IPC_CHANNELS = {
  componentLeave: 'cherry-toolbox:component:leave',
  getAppInfo: 'cherry-toolbox:get-app-info',
  safetyGetState: 'cherry-toolbox:safety:get-state',
  safetyStateChanged: 'cherry-toolbox:safety:state-changed',
  networkSwitcherGetState: 'cherry-toolbox:network-switcher:get-state',
  networkSwitcherCancelAdapterOperation: 'cherry-toolbox:network-switcher:cancel-adapter-operation',
  networkSwitcherActivateSplitRouting:
    'cherry-toolbox:network-switcher:activate-split-routing',
  networkSwitcherDeactivateSplitRouting:
    'cherry-toolbox:network-switcher:deactivate-split-routing',
  networkSwitcherPreflightSplitRouting:
    'cherry-toolbox:network-switcher:preflight-split-routing',
  networkSwitcherRestoreAdapterStates:
    'cherry-toolbox:network-switcher:restore-adapter-states',
  networkSwitcherSaveSplitRoutingSettings:
    'cherry-toolbox:network-switcher:save-split-routing-settings',
  networkSwitcherSelectAdapter:
    'cherry-toolbox:network-switcher:select-adapter',
  networkSwitcherSetAdapterState:
    'cherry-toolbox:network-switcher:set-adapter-state',
  networkSwitcherVerifySplitRouting:
    'cherry-toolbox:network-switcher:verify-split-routing',
  networkSwitcherStateChanged:
    'cherry-toolbox:network-switcher:state-changed',
  wechatAutoReplyGetState: 'cherry-toolbox:wechat-auto-reply:get-state',
  wechatAutoReplySaveSettings:
    'cherry-toolbox:wechat-auto-reply:save-settings',
  wechatAutoReplyStart: 'cherry-toolbox:wechat-auto-reply:start',
  wechatAutoReplyStateChanged:
    'cherry-toolbox:wechat-auto-reply:state-changed',
  wechatAutoReplyStop: 'cherry-toolbox:wechat-auto-reply:stop',
} as const;
