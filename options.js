// --- Rule Definitions & Modifiers ---
const RULE_TYPES = {
  child: 'Child Tab',
  sibling: 'Sibling Tab',
  parent: 'Parent Tab (Opener)',
  adjacent: 'Adjacent Tab',
  nearest: 'Nearest Tab',
  edge: 'Furthest Edge Tab',
  mru: 'Last Accessed (MRU)',
  random: 'Random Tab',
  oldest: 'Oldest Tab',
};

const MODIFIERS = {
  child: [
    { val: 'adjacent_right', label: 'Adjacent on Right' },
    { val: 'adjacent_left', label: 'Adjacent on Left' },
    { val: 'right', label: 'Nearest to the Right' },
    { val: 'left', label: 'Nearest to the Left' },
    { val: 'closest', label: 'Closest (Either Side)' },
    { val: 'rightmost', label: 'Rightmost' },
    { val: 'leftmost', label: 'Leftmost' },
    { val: 'mru', label: 'Most Recently Used' },
    { val: 'oldest', label: 'Oldest' },
    { val: 'newest', label: 'Newest' },
  ],
  sibling: [
    { val: 'adjacent_right', label: 'Adjacent on Right' },
    { val: 'adjacent_left', label: 'Adjacent on Left' },
    { val: 'right', label: 'Nearest to the Right' },
    { val: 'left', label: 'Nearest to the Left' },
    { val: 'closest', label: 'Closest (Either Side)' },
    { val: 'mru', label: 'Most Recently Used' },
    { val: 'leftmost', label: 'Leftmost' },
    { val: 'rightmost', label: 'Rightmost' },
  ],
  parent: [],
  adjacent: [
    { val: 'left', label: 'To the Left' },
    { val: 'right', label: 'To the Right' },
  ],
  nearest: [
    { val: 'left', label: 'To the Left' },
    { val: 'right', label: 'To the Right' },
    { val: 'either', label: 'Either Side' },
  ],
  edge: [
    { val: 'leftmost', label: 'Leftmost' },
    { val: 'rightmost', label: 'Rightmost' },
  ],
  mru: [],
  random: [],
  oldest: [],
};

const DEFAULT_RULES = [
  { type: 'child', modifier: 'rightmost' },
  { type: 'sibling', modifier: 'adjacent_right' },
  { type: 'sibling', modifier: 'adjacent_left' },
  { type: 'sibling', modifier: 'closest' },
  { type: 'parent', modifier: null },
  { type: 'mru', modifier: null },
];

let currentRules = [];
let draggedIndex = null;
let dropTargetIndex = null;
let placeholder = null;

// --- DOM Elements ---
const rulesListEl = document.getElementById('rules-list');
const btnAddRule = document.getElementById('btn-add-rule');
const btnSave = document.getElementById('btn-save');
const btnReset = document.getElementById('btn-reset');
const statusMsg = document.getElementById('status-message');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  const data = await browser.storage.local.get('focusRules');
  currentRules = data.focusRules && data.focusRules.length > 0 ? data.focusRules : structuredClone(DEFAULT_RULES);
  renderRules();
});

rulesListEl.addEventListener('dragover', (e) => e.preventDefault());

rulesListEl.addEventListener('drop', (e) => {
  e.preventDefault();
  placeholder?.parentNode?.removeChild(placeholder);
  if (draggedIndex === null || dropTargetIndex === null) return;
  const item = currentRules.splice(draggedIndex, 1)[0];
  const insertAt = dropTargetIndex > draggedIndex ? dropTargetIndex - 1 : dropTargetIndex;
  currentRules.splice(insertAt, 0, item);
  draggedIndex = null;
  dropTargetIndex = null;
  renderRules();
});

// --- Rendering Logic ---
function renderRules() {
  rulesListEl.innerHTML = '';
  currentRules.forEach((rule, index) => {
    const row = createRuleElement(rule, index);
    rulesListEl.appendChild(row);
  });
}

function getOrCreatePlaceholder() {
  if (!placeholder) {
    placeholder = document.createElement('div');
    placeholder.className = 'drop-placeholder';
  }
  return placeholder;
}

function getDropIndex() {
  if (!placeholder || !placeholder.parentNode) return currentRules.length;
  const children = [...rulesListEl.children];
  return children.slice(0, children.indexOf(placeholder)).filter((el) => el.classList.contains('rule-row')).length;
}

function createRuleElement(rule, index) {
  const row = document.createElement('div');
  row.className = 'rule-row';
  row.draggable = true;
  row.dataset.index = index;

  // Drag Handle
  const handle = document.createElement('div');
  handle.className = 'drag-handle';
  handle.textContent = '⋮⋮';
  row.appendChild(handle);

  // Type Dropdown
  const typeSelect = document.createElement('select');
  for (const [key, label] of Object.entries(RULE_TYPES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label;
    if (key === rule.type) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  row.appendChild(typeSelect);

  // Modifier Dropdown
  const modSelect = document.createElement('select');
  row.appendChild(modSelect);

  // Function to populate modifier dropdown based on selected type
  const updateModifiers = () => {
    modSelect.innerHTML = '';
    const type = typeSelect.value;
    const mods = MODIFIERS[type];

    if (mods && mods.length > 0) {
      modSelect.classList.remove('hidden');
      mods.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.val;
        opt.textContent = m.label;
        if (m.val === currentRules[index].modifier) opt.selected = true;
        modSelect.appendChild(opt);
      });
      // Ensure current array state reflects the valid modifier
      currentRules[index].modifier = modSelect.value;
    } else {
      modSelect.classList.add('hidden');
      currentRules[index].modifier = null;
    }
    currentRules[index].type = type;
  };

  // Listeners for dropdowns
  typeSelect.addEventListener('change', updateModifiers);
  modSelect.addEventListener('change', () => {
    currentRules[index].modifier = modSelect.value;
  });

  // Initialize modifiers
  updateModifiers();

  // Remove Button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove';
  removeBtn.innerHTML = '✖';
  removeBtn.title = 'Remove Rule';
  removeBtn.onclick = () => {
    currentRules.splice(index, 1);
    renderRules();
  };
  row.appendChild(removeBtn);

  // --- Drag and Drop Events ---
  row.addEventListener('dragstart', (e) => {
    draggedIndex = index;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => row.classList.add('dragging'), 0);
  });

  row.addEventListener('dragend', () => {
    draggedIndex = null;
    dropTargetIndex = null;
    row.classList.remove('dragging');
    placeholder?.parentNode?.removeChild(placeholder);
  });

  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (draggedIndex === null) return;
    const rect = row.getBoundingClientRect();
    const targetIdx = e.clientY < rect.top + rect.height / 2 ? index : index + 1;

    if (targetIdx === draggedIndex || targetIdx === draggedIndex + 1) {
      placeholder?.parentNode?.removeChild(placeholder);
      dropTargetIndex = null;
      return;
    }

    dropTargetIndex = targetIdx;
    const ph = getOrCreatePlaceholder();
    if (e.clientY < rect.top + rect.height / 2) {
      rulesListEl.insertBefore(ph, row);
    } else {
      rulesListEl.insertBefore(ph, row.nextSibling);
    }
  });

  return row;
}

// --- Action Handlers ---

// Add Rule button, disable if there are already 10 rules
btnAddRule.addEventListener('click', () => {
  if (currentRules.length >= 10) {
    alert('Maximum of 10 rules reached.');
    statusMsg.style.color = 'red';
    return;
  }
  currentRules.push({ type: 'adjacent', modifier: 'right' });
  renderRules();
});

btnReset.addEventListener('click', () => {
  if (confirm('Reset to default priority rules?')) {
    currentRules = structuredClone(DEFAULT_RULES);
    renderRules();
  }
});

btnSave.addEventListener('click', async () => {
  // Deduplicate consecutive identical rules
  let cleanRules = [];
  for (const rule of currentRules) {
    const lastRule = cleanRules[cleanRules.length - 1];
    // Only push if it's NOT an exact match of the immediately preceding rule
    if (!lastRule || lastRule.type !== rule.type || lastRule.modifier !== rule.modifier) {
      cleanRules.push(rule);
    }
  }

  // Apply max limit of 10
  currentRules = cleanRules.slice(0, 10);

  // Re-render the UI immediately to show the user if any duplicates/extras were removed
  renderRules();

  await browser.storage.local.set({ focusRules: currentRules });
  statusMsg.textContent = 'Preferences saved!';
  statusMsg.style.color = '#058b00';
  setTimeout(() => (statusMsg.textContent = ''), 3000);
});
