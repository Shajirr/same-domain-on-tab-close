let DEBUG = false;

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

// Modifier logic for resolving specific targets within an array of candidates
function applyModifier(candidates, modifier) {
  if (!candidates || candidates.length === 0) return null;

  switch (modifier) {
    case 'leftmost':
      return candidates.sort((a, b) => a.index - b.index)[0].id;
    case 'rightmost':
      return candidates.sort((a, b) => b.index - a.index)[0].id;
    case 'oldest':
      return candidates.sort((a, b) => a.id - b.id)[0].id;
    case 'newest':
      return candidates.sort((a, b) => b.id - a.id)[0].id;
    case 'mru':
    default:
      for (let i = recent.length - 1; i >= 0; i--) {
        const rId = recent[i];
        if (candidates.some((c) => c.id === rId)) return rId;
      }
      return candidates[0].id; // Fallback if no MRU match
  }
}

// --- Main functions ---

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

      // Dynamic priority logic
      for (const rule of focusRules) {
        if (successorId !== null) break;

        switch (rule.type) {
          case 'adjacent':
            if (rule.modifier === 'left') {
              // Strictly the immediately neighboring tab to the left
              const leftAdj = windowTabs[activeIdx - 1];
              if (leftAdj && candidate(leftAdj)) {
                successorId = leftAdj.id;
                reason = `adjacent left${domainTag}`;
              }
            } else if (rule.modifier === 'right') {
              // Strictly the immediately neighboring tab to the right
              const rightAdj = windowTabs[activeIdx + 1];
              if (rightAdj && candidate(rightAdj)) {
                successorId = rightAdj.id;
                reason = `adjacent right${domainTag}`;
              }
            }
            break;

          case 'nearest':
            if (rule.modifier === 'left') {
              for (let i = activeIdx - 1; i >= 0; i--) {
                if (candidate(windowTabs[i])) {
                  successorId = windowTabs[i].id;
                  reason = `nearest left${domainTag}`;
                  break;
                }
              }
            } else if (rule.modifier === 'right') {
              for (let i = activeIdx + 1; i < windowTabs.length; i++) {
                if (candidate(windowTabs[i])) {
                  successorId = windowTabs[i].id;
                  reason = `nearest right${domainTag}`;
                  break;
                }
              }
            } else if (rule.modifier === 'either') {
              let offset = 1;
              while (activeIdx - offset >= 0 || activeIdx + offset < windowTabs.length) {
                const left = windowTabs[activeIdx - offset];
                const right = windowTabs[activeIdx + offset];
                if (left && candidate(left)) {
                  successorId = left.id;
                  reason = `nearest either (left)${domainTag}`;
                  break;
                }
                if (right && candidate(right)) {
                  successorId = right.id;
                  reason = `nearest either (right)${domainTag}`;
                  break;
                }
                offset++;
              }
            }
            break;

          case 'edge':
            if (rule.modifier === 'leftmost') {
              const match = windowTabs.find(candidate);
              if (match) {
                successorId = match.id;
                reason = `edge leftmost${domainTag}`;
              }
            } else if (rule.modifier === 'rightmost') {
              const match = [...windowTabs].reverse().find(candidate);
              if (match) {
                successorId = match.id;
                reason = `edge rightmost${domainTag}`;
              }
            }
            break;

          case 'parent':
            if (activeTab.openerTabId !== undefined) {
              const parent = windowTabs.find((t) => t.id === activeTab.openerTabId);
              if (candidate(parent)) {
                successorId = parent.id;
                reason = `parent${domainTag}`;
              }
            }
            break;

          case 'child': {
            const children = windowTabs.filter((t) => t.openerTabId === activeTabId && candidate(t));
            if (children.length > 0) {
              if (rule.modifier === 'adjacent_right') {
                const rightTab = windowTabs[activeIdx + 1];
                if (rightTab && children.some((c) => c.id === rightTab.id)) {
                  successorId = rightTab.id;
                  reason = `child adjacent right${domainTag}`;
                }
              } else if (rule.modifier === 'adjacent_left') {
                const leftTab = windowTabs[activeIdx - 1];
                if (leftTab && children.some((c) => c.id === leftTab.id)) {
                  successorId = leftTab.id;
                  reason = `child adjacent left${domainTag}`;
                }
              } else if (rule.modifier === 'right') {
                for (let i = activeIdx + 1; i < windowTabs.length; i++) {
                  if (children.some((c) => c.id === windowTabs[i].id)) {
                    successorId = windowTabs[i].id;
                    reason = `child nearest right${domainTag}`;
                    break;
                  }
                }
              } else if (rule.modifier === 'left') {
                for (let i = activeIdx - 1; i >= 0; i--) {
                  if (children.some((c) => c.id === windowTabs[i].id)) {
                    successorId = windowTabs[i].id;
                    reason = `child nearest left${domainTag}`;
                    break;
                  }
                }
              } else if (rule.modifier === 'closest') {
                const sorted = [...children].sort(
                  (a, b) => Math.abs(a.index - activeIdx) - Math.abs(b.index - activeIdx),
                );
                successorId = sorted[0].id;
                reason = `child closest${domainTag}`;
              } else {
                successorId = applyModifier(children, rule.modifier);
                if (successorId) reason = `child ${rule.modifier}${domainTag}`;
              }
            }
            break;
          }

          case 'sibling':
            if (activeTab.openerTabId !== undefined) {
              const siblings = windowTabs.filter((t) => t.openerTabId === activeTab.openerTabId && candidate(t));
              if (siblings.length > 0) {
                if (rule.modifier === 'adjacent_right') {
                  const rightTab = windowTabs[activeIdx + 1];
                  if (rightTab && siblings.some((s) => s.id === rightTab.id)) {
                    successorId = rightTab.id;
                    reason = `right sibling${domainTag}`;
                  }
                } else if (rule.modifier === 'adjacent_left') {
                  const leftTab = windowTabs[activeIdx - 1];
                  if (leftTab && siblings.some((s) => s.id === leftTab.id)) {
                    successorId = leftTab.id;
                    reason = `left sibling${domainTag}`;
                  }
                } else if (rule.modifier === 'right') {
                  for (let i = activeIdx + 1; i < windowTabs.length; i++) {
                    if (siblings.some((s) => s.id === windowTabs[i].id)) {
                      successorId = windowTabs[i].id;
                      reason = `sibling nearest right${domainTag}`;
                      break;
                    }
                  }
                } else if (rule.modifier === 'left') {
                  for (let i = activeIdx - 1; i >= 0; i--) {
                    if (siblings.some((s) => s.id === windowTabs[i].id)) {
                      successorId = windowTabs[i].id;
                      reason = `sibling nearest left${domainTag}`;
                      break;
                    }
                  }
                } else if (rule.modifier === 'closest') {
                  const sortedSiblings = [...siblings].sort(
                    (a, b) => Math.abs(a.index - activeIdx) - Math.abs(b.index - activeIdx),
                  );
                  successorId = sortedSiblings[0].id;
                  reason = `closest sibling${domainTag}`;
                } else if (['mru', 'leftmost', 'rightmost', 'oldest', 'newest'].includes(rule.modifier)) {
                  successorId = applyModifier(siblings, rule.modifier);
                  if (successorId) reason = `sibling ${rule.modifier}${domainTag}`;
                }
              }
            }
            break;

          case 'mru':
            for (let i = recent.length - 1; i >= 0; i--) {
              const rId = recent[i];
              const t = windowTabs.find((tab) => tab.id === rId);
              if (candidate(t)) {
                successorId = rId;
                reason = `mru${domainTag}`;
                break;
              }
            }
            break;

          case 'random': {
            const pool = windowTabs.filter(candidate);
            if (pool.length > 0) {
              successorId = pool[Math.floor(Math.random() * pool.length)].id;
              reason = `random${domainTag}`;
            }
            break;
          }

          case 'oldest': {
            // Oldest by tab id (lower id = opened earlier)
            const pool = windowTabs.filter(candidate);
            if (pool.length > 0) {
              successorId = pool.reduce((a, b) => (a.id < b.id ? a : b)).id;
              reason = `oldest${domainTag}`;
            }
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
      // Firefox chain-follows successors transitively on tab close: if A→B→C,
      // closing A activates B but immediately also follows B→C, causing two hops.
      // Fix: always clear B's stored successor before setting A→B. When B becomes
      // active, updateSuccessor will compute the correct successor for it then.
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
