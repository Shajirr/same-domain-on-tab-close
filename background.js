let DEBUG = true;

let enabled = true; // addon state
let recent = []; // tabId[] ordered by activation time, most recent at the end
let activeTabId = undefined;
let focusRules = []; // Dynamically loaded rules array

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

const DEFAULT_RULES = [
  { type: 'child', modifier: 'rightmost' },
  { type: 'sibling', modifier: 'adjacent_right' },
  { type: 'sibling', modifier: 'adjacent_left' },
  { type: 'sibling', modifier: 'closest' },
  { type: 'parent', modifier: null },
  { type: 'mru', modifier: null },
];

async function loadState() {
  const result = await browser.storage.local.get(['enabled', 'focusRules']);
  enabled = result.enabled !== undefined ? result.enabled : true;
  focusRules = result.focusRules && result.focusRules.length > 0 ? result.focusRules : DEFAULT_RULES;
  updateIcon();
}

async function saveState() {
  await browser.storage.local.set({ enabled });
}

// Keep rules in sync if the user changes them in the options page
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.focusRules) {
    focusRules =
      changes.focusRules.newValue && changes.focusRules.newValue.length > 0
        ? changes.focusRules.newValue
        : DEFAULT_RULES;
    if (activeTabId) updateSuccessor();
  }
});

async function saveTabOpener(tabId, openerTabId) {
  await browser.sessions.setTabValue(tabId, 'openerTabId', openerTabId).catch(() => {});
}

function updateIcon() {
  browser.browserAction.setTitle({
    title: `Same Domain On Tab Close: ${enabled ? 'on' : 'off'}`,
  });
  if (enabled) {
    browser.browserAction.setBadgeText({ text: '' });
  } else {
    browser.browserAction.setBadgeText({ text: 'off' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#CC0000' });
    browser.browserAction.setBadgeTextColor({ color: '#000000' });
  }
}

browser.browserAction.onClicked.addListener(() => {
  enabled = !enabled;
  saveState();
  updateIcon();
  updateSuccessor();
  logDebug('[SDT] toggled, enabled=', enabled);
});

// --- Context Menu for Options ---
browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({
    id: 'open-options',
    title: 'Options',
    contexts: ['browser_action'],
  });
});

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-options') {
    browser.runtime.openOptionsPage();
  }
});

// --- Helpers ---

function isValidUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    // Strict protocol check ignores about:, chrome:, moz-extension:, file:
    return ['http:', 'https:', 'ftp:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function getHostname(url) {
  if (!isValidUrl(url)) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 40) : '');
  } catch {
    return String(url);
  }
}

// --- Main functions ---

// Modifier logic for resolving specific targets within an array of candidates.
function applyModifier(candidates, modifier, { activeIdx, windowTabs } = {}) {
  if (!candidates || candidates.length === 0) return null;
  const idSet = new Set(candidates.map((c) => c.id));

  switch (modifier) {
    // --- Position-independent ---
    case 'leftmost':
      return [...candidates].sort((a, b) => a.index - b.index)[0].id;
    case 'rightmost':
      return [...candidates].sort((a, b) => b.index - a.index)[0].id;
    case 'oldest':
      return [...candidates].sort((a, b) => a.id - b.id)[0].id;
    case 'newest':
      return [...candidates].sort((a, b) => b.id - a.id)[0].id;
    case 'random':
      return candidates[Math.floor(Math.random() * candidates.length)].id;
    case 'mru':
      for (let i = recent.length - 1; i >= 0; i--) {
        if (idSet.has(recent[i])) return recent[i];
      }
      return candidates[0].id; // Fallback if no MRU match

    // --- Position-dependent ---
    case 'adjacent_right': {
      const t = windowTabs[activeIdx + 1];
      return t && idSet.has(t.id) ? t.id : null;
    }
    case 'adjacent_left': {
      const t = windowTabs[activeIdx - 1];
      return t && idSet.has(t.id) ? t.id : null;
    }
    case 'right':
      for (let i = activeIdx + 1; i < windowTabs.length; i++) {
        if (idSet.has(windowTabs[i].id)) return windowTabs[i].id;
      }
      return null;
    case 'left':
      for (let i = activeIdx - 1; i >= 0; i--) {
        if (idSet.has(windowTabs[i].id)) return windowTabs[i].id;
      }
      return null;
    case 'closest':
    case 'either': {
      // Expand outward from activeIdx, preferring left on a tie
      let offset = 1;
      while (activeIdx - offset >= 0 || activeIdx + offset < windowTabs.length) {
        const l = windowTabs[activeIdx - offset];
        const r = windowTabs[activeIdx + offset];
        if (l && idSet.has(l.id)) return l.id;
        if (r && idSet.has(r.id)) return r.id;
        offset++;
      }
      return null;
    }
    default:
      return null;
  }
}

async function restoreOpenerTabIds(tabs) {
  for (const tab of tabs) {
    if (tab.openerTabId !== undefined) continue;
    const savedOpenerId = await browser.sessions.getTabValue(tab.id, 'openerTabId').catch(() => undefined);
    if (savedOpenerId === undefined) continue;
    // Verify the opener tab still exists
    const openerExists = tabs.some((t) => t.id === savedOpenerId);
    if (!openerExists) continue;
    try {
      await browser.tabs.update(tab.id, { openerTabId: savedOpenerId });
      logDebug(`[SDT] Restored openerTabId for tab ${tab.id} → ${savedOpenerId}`);
    } catch (e) {
      logDebug(`[SDT] Failed to restore openerTabId for tab ${tab.id}:`, e);
    }
  }
}

async function updateSuccessor() {
  if (activeTabId === undefined) return;

  try {
    // If the extension is disabled, clear successor of the active tab
    if (!enabled) {
      await browser.tabs.update(activeTabId, { successorTabId: -1 }).catch(() => {});
      logDebug(`[SDT] Extension disabled, cleared successor for: ${activeTabId}`);
      return;
    }

    const activeTab = await browser.tabs.get(activeTabId);

    // Stop if pinned or invalid URL
    if (!activeTab || activeTab.pinned || !isValidUrl(activeTab.url)) {
      await browser.tabs.update(activeTabId, { successorTabId: -1 }).catch(() => {});
      return;
    }

    const hostname = getHostname(activeTab.url);
    let windowTabs = await browser.tabs.query({ windowId: activeTab.windowId });
    windowTabs.sort((a, b) => a.index - b.index);

    const activeIdx = windowTabs.findIndex((t) => t.id === activeTabId);

    // Filter logic for candidates, optionally requiring same domain
    const isValidCandidate = (t, requireSameDomain = true) => {
      return (
        t &&
        t.id !== activeTab.id &&
        !t.pinned &&
        isValidUrl(t.url) &&
        (!requireSameDomain || getHostname(t.url) === hostname)
      );
    };

    const hasSameDomainTabs = windowTabs.some((t) => isValidCandidate(t, true));

    let successorId = null;
    let reason = '';

    // Run through focusRules; if requireSameDomain is false, domain check is skipped
    const runRules = (requireSameDomain) => {
      const candidate = (t) => isValidCandidate(t, requireSameDomain);
      const domainTag = requireSameDomain ? '' : ' (any domain)';
      const ctx = { activeIdx, windowTabs };

      // Dynamic priority logic
      for (const rule of focusRules) {
        if (successorId !== null) break;

        switch (rule.type) {
          case 'adjacent': {
            // 'left'/'right' on the adjacent type means strictly the immediate neighbor,
            // which maps to the adjacent_left/adjacent_right modifier in applyModifier
            const mod = rule.modifier === 'left' ? 'adjacent_left' : 'adjacent_right';
            successorId = applyModifier(windowTabs.filter(candidate), mod, ctx);
            if (successorId) reason = `adjacent ${rule.modifier}${domainTag}`;
            break;
          }

          case 'nearest': {
            // 'either' expands outward; 'left'/'right' scan in one direction
            successorId = applyModifier(windowTabs.filter(candidate), rule.modifier, ctx);
            if (successorId) reason = `nearest ${rule.modifier}${domainTag}`;
            break;
          }

          case 'edge': {
            successorId = applyModifier(windowTabs.filter(candidate), rule.modifier, ctx);
            if (successorId) reason = `edge ${rule.modifier}${domainTag}`;
            break;
          }

          case 'parent': {
            if (activeTab.openerTabId !== undefined) {
              const parent = windowTabs.find((t) => t.id === activeTab.openerTabId);
              if (candidate(parent)) {
                successorId = parent.id;
                reason = `parent${domainTag}`;
              }
            }
            break;
          }

          case 'child': {
            const children = windowTabs.filter((t) => t.openerTabId === activeTabId && candidate(t));
            successorId = applyModifier(children, rule.modifier, ctx);
            if (successorId) reason = `child ${rule.modifier}${domainTag}`;
            break;
          }

          case 'sibling': {
            if (activeTab.openerTabId !== undefined) {
              const siblings = windowTabs.filter((t) => t.openerTabId === activeTab.openerTabId && candidate(t));
              successorId = applyModifier(siblings, rule.modifier, ctx);
              if (successorId) reason = `sibling ${rule.modifier}${domainTag}`;
            }
            break;
          }

          case 'mru': {
            successorId = applyModifier(windowTabs.filter(candidate), 'mru', ctx);
            if (successorId) reason = `mru${domainTag}`;
            break;
          }

          case 'random': {
            successorId = applyModifier(windowTabs.filter(candidate), 'random');
            if (successorId) reason = `random${domainTag}`;
            break;
          }

          case 'oldest': {
            successorId = applyModifier(windowTabs.filter(candidate), 'oldest');
            if (successorId) reason = `oldest${domainTag}`;
            break;
          }
        }
      }
    };

    // If no same-domain tabs exist at all, skip straight to the domain-agnostic pass
    if (!hasSameDomainTabs) {
      logDebug(`[SDT] No same-domain tabs for ${activeTabId}, skipping to any-domain rules`);
      runRules(false);
    } else {
      runRules(true);
      // Fallback: if same-domain rules all failed, try again without domain requirement
      if (successorId === null) {
        logDebug(`[SDT] All same-domain rules failed for ${activeTabId}, falling back to any-domain rules`);
        runRules(false);
      }
    }

    // Apply the successor
    if (successorId !== null) {
      // Firefox chain-follows successors transitively on tab close: closing A→B also
      // activates B then immediately follows B's stored successor, causing two hops.
      // Unconditionally clear B's successor here — when B becomes active,
      // updateSuccessor will compute the correct one for it from scratch.
      await browser.tabs.update(successorId, { successorTabId: -1 }).catch(() => {});

      await browser.tabs.update(activeTabId, { successorTabId: successorId });
      const successorTabInfo = await browser.tabs.get(successorId).catch(() => null);
      logDebug(
        `[SDT] Successor set for: ${activeTabId} (${shortUrl(activeTab.url)}) to: ${successorId} (${shortUrl(successorTabInfo?.url)}) [Rule Match: ${reason}]`,
      );
    } else {
      await browser.tabs.update(activeTabId, { successorTabId: -1 });
      logDebug(`[SDT] No same-domain successor for: ${activeTabId} (${shortUrl(activeTab.url)})`);
    }
  } catch (e) {
    logDebug(`[SDT] Error updating successor:`, e);
  }
}

// --- Initialization ---

browser.tabs.query({}).then(async (tabs) => {
  tabs.sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
  recent = tabs.map((t) => t.id);

  await restoreOpenerTabIds(tabs);

  const activeTab = tabs.find((t) => t.active);
  if (activeTab) {
    activeTabId = activeTab.id;
    updateSuccessor();
  }
});

// --- Listeners ---

browser.tabs.onCreated.addListener((tab) => {
  recent.push(tab.id);

  // Persist the opener ID so it survives a crash/restart
  if (tab.openerTabId !== undefined) {
    saveTabOpener(tab.id, tab.openerTabId);
    logDebug(`[SDT] Saved openerTabId for ${tab.id}, opener: ${tab.openerTabId}`);
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === activeTabId) {
    // Only update if the active tab's URL or Pinned status changes
    if (changeInfo.url !== undefined || changeInfo.pinned !== undefined) {
      updateSuccessor();
    }
  } else if (changeInfo.status === 'complete') {
    // Trigger update when background tab finishes loading
    updateSuccessor();
  }
});

browser.tabs.onActivated.addListener(async ({ tabId, previousTabId }) => {
  activeTabId = tabId;
  const i = recent.indexOf(tabId);
  if (i > -1) recent.splice(i, 1);
  recent.push(tabId);

  try {
    const tab = await browser.tabs.get(tabId);
    const successorId = tab.successorTabId && tab.successorTabId !== -1 ? tab.successorTabId : null;
    let successorInfo = 'none';
    if (successorId) {
      const sTab = await browser.tabs.get(successorId).catch(() => null);
      successorInfo = `${successorId} (${sTab ? shortUrl(sTab.url) : '?'})`;
    }
    const fromInfo = previousTabId !== undefined ? ` from ${previousTabId}` : '';
    logDebug(`[SDT] activated tab ${tabId} (${shortUrl(tab.url)})${fromInfo}, successor: ${successorInfo}`);
  } catch {}

  updateSuccessor();
});

// Reacting to tab movement ensures the left/right logic stays accurate
browser.tabs.onMoved.addListener(() => {
  updateSuccessor();
});

browser.tabs.onRemoved.addListener((tabId) => {
  logDebug(`[SDT] closed tab ${tabId}${activeTabId === tabId ? ' (was active)' : ''}`);
  const i = recent.indexOf(tabId);
  if (i > -1) recent.splice(i, 1);
  if (activeTabId === tabId) activeTabId = undefined;
});

loadState();
