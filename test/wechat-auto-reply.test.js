const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadWeChatAutoReplySettings,
  normalizeWeChatAutoReplyInput,
  parseWeChatAutoReplySettings,
  saveWeChatAutoReplySettings,
} = require('../dist/main/wechat-auto-reply-settings.js');
const {
  WeChatAutoReplyService,
} = require('../dist/main/wechat-auto-reply.js');
const {
  loadWeChatAutoReplyRateLimitState,
  localDateKey,
  saveWeChatAutoReplyRateLimitState,
} = require('../dist/main/wechat-auto-reply-rate-limit.js');

test('auto-reply input trims and deduplicates exact contact names', () => {
  assert.deepEqual(
    normalizeWeChatAutoReplyInput({
      allowlist: [' Alice ', 'Bob', 'Alice', '', '  '],
      cooldownMinutes: 30,
      dailyLimit: 20,
      dryRun: true,
      replyText: ' Away right now. ',
    }),
    {
      allowlist: ['Alice', 'Bob'],
      cooldownMinutes: 30,
      dailyLimit: 20,
      dryRun: true,
      replyText: 'Away right now.',
    },
  );
});

test('live WeChat sending is rejected because it cannot be rolled back', () => {
  assert.throws(
    () =>
      normalizeWeChatAutoReplyInput({
        allowlist: ['Alice'],
        cooldownMinutes: 30,
        dailyLimit: 10,
        dryRun: false,
        replyText: 'Unavailable',
      }),
    /Live WeChat sending is disabled/,
  );
});

test('auto-reply cannot be configured without text and an allowlist', () => {
  assert.throws(
    () =>
      normalizeWeChatAutoReplyInput({
        allowlist: ['Alice'],
        cooldownMinutes: 30,
        dailyLimit: 20,
        dryRun: true,
        replyText: '',
      }),
    /reply message/u,
  );
  assert.throws(
    () =>
      normalizeWeChatAutoReplyInput({
        allowlist: [],
        cooldownMinutes: 30,
        dailyLimit: 20,
        dryRun: true,
        replyText: 'Away',
      }),
    /at least one/u,
  );
});

test('auto-reply settings persist safely and corrupt data disables the worker', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'cherry-toolbox-wechat-auto-reply-'),
  );
  try {
    const settings = {
      allowlist: ['Alice', 'Bob'],
      cooldownMinutes: 30,
      dailyLimit: 20,
      dryRun: true,
      enabled: true,
      replyText: 'I will reply later.',
      version: 2,
    };
    await saveWeChatAutoReplySettings(directory, settings);
    assert.deepEqual(await loadWeChatAutoReplySettings(directory), settings);

    const stored = JSON.parse(
      await readFile(path.join(directory, 'settings.json'), 'utf8'),
    );
    assert.equal(stored.version, 2);
    assert.deepEqual(
      parseWeChatAutoReplySettings({ ...stored, allowlist: 'Alice' }),
      {
        allowlist: [],
        cooldownMinutes: 30,
        dailyLimit: 20,
        dryRun: true,
        enabled: false,
        replyText: '',
        version: 2,
      },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('a fresh app launch never resumes a previously enabled worker', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'cherry-toolbox-wechat-auto-reply-service-'),
  );
  try {
    await saveWeChatAutoReplySettings(directory, {
      allowlist: ['Alice'],
      cooldownMinutes: 30,
      dailyLimit: 20,
      dryRun: true,
      enabled: true,
      replyText: 'I will reply later.',
      version: 2,
    });
    const service = new WeChatAutoReplyService({
      dataDirectory: directory,
      projectRoot: directory,
      sourceMode: true,
      stateChanged: () => undefined,
    });
    await service.initialize();
    const state = service.getState();
    assert.equal(state.settings.enabled, false);
    assert.equal(state.status, 'stopped');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('legacy settings migrate to dry run and conservative limits', () => {
  assert.deepEqual(
    parseWeChatAutoReplySettings({
      allowlist: ['Alice'],
      enabled: true,
      replyText: 'Away',
      version: 1,
    }),
    {
      allowlist: ['Alice'],
      cooldownMinutes: 30,
      dailyLimit: 20,
      dryRun: true,
      enabled: true,
      replyText: 'Away',
      version: 2,
    },
  );
});

test('auto-reply rejects unsafe rate limits and oversized allowlists', () => {
  const base = {
    allowlist: ['Alice'],
    cooldownMinutes: 30,
    dailyLimit: 20,
    dryRun: true,
    replyText: 'Away',
  };
  assert.throws(
    () => normalizeWeChatAutoReplyInput({ ...base, cooldownMinutes: 0 }),
    /cooldown/u,
  );
  assert.throws(
    () => normalizeWeChatAutoReplyInput({ ...base, dailyLimit: 101 }),
    /daily reply limit/u,
  );
  assert.throws(
    () =>
      normalizeWeChatAutoReplyInput({
        ...base,
        allowlist: Array.from({ length: 11 }, (_, index) => `Friend ${index}`),
      }),
    /limited to 10/u,
  );
});

test('reply limits survive restarts and corrupt state fails closed', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'cherry-toolbox-wechat-rate-limit-'),
  );
  try {
    const state = {
      dailyCount: 7,
      date: localDateKey(),
      lastReplyAtByContact: {
        Alice: '2026-08-15T01:02:03.000Z',
      },
      version: 1,
    };
    await saveWeChatAutoReplyRateLimitState(directory, state);
    assert.deepEqual(
      await loadWeChatAutoReplyRateLimitState(directory),
      state,
    );

    await writeFile(path.join(directory, 'rate-limit.json'), '{broken', 'utf8');
    const blocked = await loadWeChatAutoReplyRateLimitState(directory);
    assert.equal(blocked.dailyCount, 100);
    assert.equal(blocked.date, localDateKey());
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
