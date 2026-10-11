const $ = id => document.getElementById(id);
let session = null, phones = [], resources = null, refreshPromise = null, pollTimer, deleteTarget = null;
let epoch = 0, keyRequest = 0;
const pending = new Set();
function initTheme() {
  try { const saved = localStorage.getItem('cloudphone-theme'); if (['dark', 'light'].includes(saved)) document.documentElement.dataset.theme = saved; } catch {}
  document.querySelector('.theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('cloudphone-theme', theme); } catch {}
  });
}
initTheme();
const bytes = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${new Intl.NumberFormat(undefined, {maximumFractionDigits: i ? 1 : 0}).format(n)} ${units[i]}`;
};
function notify(message, error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
function showLogin(message = '') {
  epoch++; session = null; phones = []; resources = null; clearTimeout(pollTimer); $('logout').hidden = true;
  $('username-display').textContent = ''; $('phone-list').replaceChildren(); $('phone-list').setAttribute('aria-busy', 'false');
  $('create-phone').disabled = true; $('login-error').textContent = message;
  $('create-dialog').close(); $('delete-dialog').close(); closeKey();
  for (const id of ['memory-value', 'disk-value', 'fleet-value']) $(id).textContent = '—';
  $('memory-detail').textContent = 'Live host usage'; $('disk-detail').textContent = 'Live host usage';
  $('fleet-detail').textContent = 'Phones running / total'; $('reserved-detail').textContent = 'Sign in to view allocations.';
  $('sdk-detail').textContent = ''; $('phone-count').textContent = '0'; $('updated-at').textContent = 'Sign in required';
  $('memory-meter').value = 0; $('disk-meter').value = 0; $('capability-warning').hidden = true; $('empty-state').hidden = true; notify('');
  if (!$('login-dialog').open) $('login-dialog').showModal();
}
async function api(path, {method = 'GET', body} = {}) {
  const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && path !== '/api/login') {
    if (!session?.csrf) throw new Error('Your session is missing a security token. Sign in again.');
    headers['X-CSRF-Token'] = session.csrf;
  }
  const res = await fetch(path, {method, headers, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000), ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  let data; try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') showLogin('Your session expired. Please sign in again.');
    throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status}). Please try again.`);
  }
  return data;
}
function setSession(data) {
  if (!data || typeof data.csrf !== 'string') throw new Error('Invalid session response. Please sign in again.');
  session = data; epoch++;
  if (data.role === 'phone') { location.replace(`/phone?id=${encodeURIComponent(data.phoneId)}`); return false; }
  if (data.mode === 'standalone') { location.replace('/'); return false; }
  $('username-display').textContent = data.username || $('username').value;
  $('logout').hidden = false; $('login-dialog').close(); return true;
}
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
function renderResources() {
  const host = resources?.host || {};
  for (const kind of ['memory', 'disk']) {
    const total = host[`${kind}TotalBytes`], available = host[`${kind}AvailableBytes`];
    $(`${kind}-value`).textContent = bytes(available);
    $(`${kind}-detail`).textContent = `${bytes(total)} total · ${bytes(typeof total === 'number' && typeof available === 'number' ? Math.max(0, total - available) : undefined)} in use`;
    const percent = total > 0 && Number.isFinite(available) ? Math.max(0, Math.min(100, (total - available) / total * 100)) : 0;
    $(`${kind}-meter`).value = percent; $(`${kind}-meter`).setAttribute('aria-valuetext', `${bytes(available)} available of ${bytes(total)}`);
  }
  $('fleet-value').textContent = `${phones.filter(p => p.status === 'running').length} / ${phones.length}`;
  $('fleet-detail').textContent = 'Running / total phones';
  $('reserved-detail').textContent = `Reserved: ${bytes(resources?.reserved?.memoryBytes)} RAM · ${bytes(resources?.reserved?.diskBytes)} disk`;
  $('sdk-detail').textContent = `Shared SDK: ${bytes(resources?.sharedSdkBytes)}. Reservations are allocations, not live usage; shared SDK storage is separate.`;
  const capable = resources?.capabilities?.ok === true;
  $('create-phone').disabled = !capable || !session;
  $('capability-warning').hidden = capable;
  const reasons = resources?.capabilities?.reasons;
  $('capability-warning').textContent = `Provisioning unavailable. ${Array.isArray(reasons) && reasons.length ? reasons.join(' · ') : 'Host capability information is unavailable.'}`;
}
function renderPhones() {
  const query = $('search').value.trim().toLowerCase();
  const visible = phones.filter(p => `${p.name} ${p.id} ${p.status}`.toLowerCase().includes(query));
  $('phone-count').textContent = String(phones.length);
  const fragment = document.createDocumentFragment();
  for (const phone of visible) {
    const id = String(phone.id), state = String(phone.status || 'unknown'), busy = pending.has(id);
    const card = element('article', 'device-card');
    const top = element('div', 'device-card-top'), symbol = element('span', 'device-symbol', '▯'); symbol.setAttribute('aria-hidden', 'true');
    const pill = element('span', 'status-pill', state); if (['running', 'stopped', 'starting', 'stopping', 'failed', 'error'].includes(state)) pill.classList.add(state);
    top.append(symbol, pill);
    const body = element('div', 'device-card-body'); body.append(element('h3', '', phone.name || id), element('div', 'device-id', id));
    const specs = element('dl', 'device-specs');
    for (const [label, value] of [['Guest RAM', bytes(typeof phone.guestRamMiB === 'number' ? phone.guestRamMiB * 1024 ** 2 : undefined)], ['Host limit', bytes(typeof phone.hostMemoryMiB === 'number' ? phone.hostMemoryMiB * 1024 ** 2 : undefined)], ['Disk limit', typeof phone.diskGiB === 'number' ? `${phone.diskGiB} GiB` : '—']]) {
      const entry = element('div'); entry.append(element('dt', '', label), element('dd', '', value)); specs.append(entry);
    }
    body.append(specs, element('p', 'device-usage', `Actual usage · ${bytes(phone.memoryBytes)} memory / ${bytes(phone.diskUsedBytes)} disk`));
    const actions = element('div', 'device-actions');
    const open = element('a', 'primary', 'Open phone ↗'); open.href = `/phone?id=${encodeURIComponent(id)}`; open.setAttribute('aria-label', `Open ${phone.name || id}`);
    if (state !== 'running') { open.classList.add('disabled-link'); open.removeAttribute('href'); open.setAttribute('aria-disabled', 'true'); }
    const action = state === 'running' ? 'stop' : 'start';
    const toggle = element('button', '', busy ? 'Working…' : action === 'stop' ? 'Stop' : 'Start'); toggle.type = 'button'; toggle.disabled = busy || !['running', 'stopped', 'failed', 'error'].includes(state);
    toggle.setAttribute('aria-label', `${action === 'stop' ? 'Stop' : 'Start'} ${phone.name || id}`);
    toggle.addEventListener('click', () => mutatePhone(phone, action));
    const remove = element('button', 'delete-button', 'Delete'); remove.type = 'button'; remove.disabled = busy || ['starting', 'stopping', 'deleting', 'creating'].includes(state);
    remove.setAttribute('aria-label', `Delete ${phone.name || id}`);
    remove.addEventListener('click', () => { deleteTarget = phone; $('delete-description').textContent = `You are deleting “${phone.name || id}”.`; $('delete-error').textContent = ''; $('delete-dialog').showModal(); $('cancel-delete').focus(); });
    const access = element('button', '', 'Access key'); access.type = 'button'; access.disabled = busy;
    access.setAttribute('aria-label', `Access key for ${phone.name || id}`);
    access.addEventListener('click', () => revealKey(phone));
    actions.append(open, toggle, access, remove); card.append(top, body, actions); fragment.append(card);
  }
  // Preserve keyboard focus when background polling replaces card controls.
  const focused = document.activeElement?.closest('.device-actions') ? document.activeElement.getAttribute('aria-label') : null;
  $('phone-list').replaceChildren(fragment);
  if (focused) Array.from($('phone-list').querySelectorAll('[aria-label]')).find(node => node.getAttribute('aria-label') === focused)?.focus({preventScroll: true});
  $('empty-state').hidden = visible.length > 0;
  $('empty-title').textContent = phones.length ? 'No phones found.' : 'A fresh start.';
  $('empty-text').textContent = phones.length ? 'Try another name, ID, or status.' : 'Create your first phone and make this space yours.';
}
async function refresh() {
  if (!session) return;
  if (refreshPromise) return refreshPromise;
  clearTimeout(pollTimer); const current = epoch;
  $('refresh').disabled = true; $('phone-list').setAttribute('aria-busy', 'true');
  refreshPromise = (async () => {
    try {
      const [inventory, capacity] = await Promise.all([api('/api/phones'), api('/api/resources')]);
      if (current !== epoch || !session) return;
      if (!Array.isArray(inventory.phones)) throw new Error('Invalid phone inventory response.');
      phones = inventory.phones; resources = capacity; renderResources(); renderPhones();
      $('updated-at').textContent = `Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    } catch (error) { if (current === epoch && session) { notify(`Could not refresh: ${error.message}`, true); $('updated-at').textContent = 'Refresh failed · data may be stale'; $('create-phone').disabled = true; } }
    finally { $('refresh').disabled = false; $('phone-list').setAttribute('aria-busy', 'false'); refreshPromise = null; if (session) pollTimer = setTimeout(() => { if (document.hidden) { pollTimer = setTimeout(refresh, 15000); return; } void refresh(); }, 15000); }
  })();
  return refreshPromise;
}
async function mutatePhone(phone, action) {
  const id = String(phone.id); if (pending.has(id)) return;
  pending.add(id); renderPhones(); const current = epoch;
  try { await api(`/api/phones/${encodeURIComponent(id)}/${action}`, {method: 'POST'}); if (current !== epoch) return; notify(`${phone.name || id}: ${action === 'start' ? 'start' : 'stop'} requested.`); }
  catch (error) { if (current === epoch) notify(error.message, true); }
  finally { pending.delete(id); if (current === epoch) { await refreshPromise; await refresh(); } }
}
function clearKey() {
  keyRequest++; $('revealed-key').value = ''; $('key-status').textContent = ''; $('key-description').textContent = ''; $('copy-key').disabled = true;
}
function closeKey() { clearKey(); $('key-dialog').close(); }
async function revealKey(phone) {
  clearKey(); const current = keyRequest, currentSession = epoch;
  $('key-description').textContent = `Access to “${phone.name || phone.id}” only.`;
  $('key-status').textContent = 'Retrieving key…'; $('key-dialog').showModal();
  try {
    const data = await api(`/api/phones/${encodeURIComponent(phone.id)}/key`, {method: 'POST'});
    if (current !== keyRequest || currentSession !== epoch || !$('key-dialog').open) return;
    if (data.id !== phone.id || typeof data.key !== 'string' || !data.key) throw new Error('Key unavailable. Please close and try again.');
    $('revealed-key').value = data.key; $('copy-key').disabled = false; $('key-status').textContent = 'Keep this key private.';
  } catch (error) { if (current === keyRequest && currentSession === epoch) $('key-status').textContent = error.message; }
}
$('close-key').addEventListener('click', closeKey);
$('key-dialog').addEventListener('close', clearKey);
$('key-dialog').addEventListener('cancel', clearKey);
$('copy-key').addEventListener('click', async () => {
  if (!$('revealed-key').value) return;
  const current = keyRequest; $('copy-key').disabled = true;
  try { await navigator.clipboard.writeText($('revealed-key').value); if (current === keyRequest) $('key-status').textContent = 'Key copied. Clear your clipboard after sharing securely.'; }
  catch { if (current === keyRequest) { $('key-status').textContent = 'Clipboard unavailable. Select the key and copy it manually.'; $('revealed-key').focus(); $('revealed-key').select(); } }
  finally { if (current === keyRequest) $('copy-key').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) closeKey(); });
$('login-dialog').addEventListener('cancel', event => event.preventDefault());
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('login-button').disabled) return; $('login-button').disabled = true; $('login-error').textContent = '';
  try { const data = await api('/api/login', {method: 'POST', body: {username: $('username').value.trim(), password: $('password').value}}); $('password').value = ''; if (setSession(data)) { await refreshPromise; await refresh(); } }
  catch (error) { $('login-error').textContent = error.message; }
  finally { $('password').value = ''; $('login-button').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await api('/api/logout', {method: 'POST'}); showLogin(); }
  catch (error) { if (session) notify(error.message, true); }
  finally { $('logout').disabled = false; }
});
$('search').addEventListener('input', renderPhones);
$('refresh').addEventListener('click', () => { notify(''); void refresh(); });
$('create-phone').addEventListener('click', () => { $('create-error').textContent = ''; $('create-dialog').showModal(); $('phone-name').focus(); });
$('cancel-create').addEventListener('click', () => $('create-dialog').close());
$('create-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('create-submit').disabled) return;
  const body = {name: $('phone-name').value.trim(), guestRamMiB: Number($('guest-ram').value), hostMemoryMiB: Number($('host-memory').value), diskGiB: Number($('disk-size').value)};
  if (!body.name || ![body.guestRamMiB, body.hostMemoryMiB, body.diskGiB].every(v => Number.isSafeInteger(v) && v > 0)) { $('create-error').textContent = 'Enter a name and positive whole-number resource limits.'; return; }
  if (body.hostMemoryMiB < body.guestRamMiB + 1024) { $('create-error').textContent = 'Host limit must include at least 1024 MiB above guest RAM for emulator overhead.'; return; }
  if (resources?.capabilities?.ok !== true) { $('create-error').textContent = 'This host is not ready to provision phones. Refresh host resources.'; return; }
  const current = epoch; $('create-submit').disabled = true; $('cancel-create').disabled = true; $('create-error').textContent = '';
  try { await api('/api/phones', {method: 'POST', body}); if (current !== epoch) return; $('create-dialog').close(); $('create-form').reset(); notify('Phone created. Start it when you are ready.'); await refreshPromise; await refresh(); }
  catch (error) { if (current === epoch) $('create-error').textContent = `${error.message} Refresh the list before retrying if the request timed out.`; }
  finally { $('create-submit').disabled = false; $('cancel-create').disabled = false; }
});
$('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
$('delete-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!deleteTarget || $('delete-submit').disabled) return;
  const target = deleteTarget, current = epoch; $('delete-submit').disabled = true; $('cancel-delete').disabled = true; $('delete-error').textContent = '';
  pending.add(String(target.id)); renderPhones();
  try { await api(`/api/phones/${encodeURIComponent(target.id)}`, {method: 'DELETE'}); if (current !== epoch) return; $('delete-dialog').close(); notify(`${target.name || target.id} deleted.`); }
  catch (error) { if (current === epoch) $('delete-error').textContent = error.message; }
  finally { pending.delete(String(target.id)); $('delete-submit').disabled = false; $('cancel-delete').disabled = false; if (current === epoch) { await refreshPromise; await refresh(); } }
});
for (const [dialog, submit] of [['create-dialog', 'create-submit'], ['delete-dialog', 'delete-submit']]) $(dialog).addEventListener('cancel', event => { if ($(submit).disabled) event.preventDefault(); });
window.addEventListener('pagehide', () => { closeKey(); epoch++; session = null; clearTimeout(pollTimer); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
(async () => { try { if (setSession(await api('/api/session'))) await refresh(); } catch (error) { showLogin(error.message.includes('401') ? '' : error.message); } })();
