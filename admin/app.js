// Admin dashboard. No build step, no framework; all text goes in through textContent.

const TOKEN_KEY = 'dm-admin-token';
const $ = (id) => document.getElementById(id);

const state = { token: null, me: null, meta: null };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// ---- storage (may be unavailable in private windows) ----
const store = {
  get: () => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t) => {
    try {
      t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* the token then lives in memory only */
    }
  },
};

// ---- API ----
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) signOut();
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText);
  }
  return data;
}

// ---- UI helpers ----
let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

const ERRORS = {
  not_authorized: 'Brak dostępu — to konto nie jest na liście albo nie ma uprawnień.',
  already_allowed: 'Ta osoba już jest na liście.',
  managed_by_environment: 'Ten admin jest ustawiony w ADMIN_EMAILS — zmień to w konfiguracji serwera.',
  cannot_change_self: 'Nie możesz odebrać uprawnień samemu sobie.',
  invalid_input: 'Nieprawidłowa wartość — sprawdź zakres.',
};
const fail = (err) => toast(ERRORS[err.code] ?? err.message, true);

function show(view) {
  for (const id of ['view-loading', 'view-signin', 'view-denied', 'view-dashboard']) $(id).hidden = id !== view;
}

const fmtNumber = (n) => new Intl.NumberFormat('pl-PL').format(n);
const fmtDate = (iso) =>
  iso ? new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—';
function fmtAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return 'dziś';
  if (days === 1) return 'wczoraj';
  if (days < 30) return `${days} dni temu`;
  return fmtDate(iso).split(',')[0];
}

// ---- sign-in ----
async function signInWith(path, payload) {
  try {
    const session = await api('POST', path, payload);
    state.token = session.token;
    store.set(session.token);
    await enter();
  } catch (err) {
    fail(err);
  }
}

function signOut() {
  state.token = null;
  state.me = null;
  store.set(null);
  $('who').hidden = true;
  try {
    window.google?.accounts.id.disableAutoSelect();
  } catch {
    /* ignore */
  }
  showSignIn();
}

function showSignIn() {
  show('view-signin');
  const clientId = state.meta?.google_web_client_id;
  $('google-missing').hidden = !!clientId;
  $('dev-login').hidden = !state.meta?.dev_login;
  if (!clientId || $('google-button').childElementCount) return;
  const script = h('script', { src: 'https://accounts.google.com/gsi/client', async: true });
  script.addEventListener('load', () => {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: ({ credential }) => signInWith('/auth/google', { id_token: credential }),
    });
    window.google.accounts.id.renderButton($('google-button'), {
      theme: 'filled_black',
      size: 'large',
      shape: 'rectangular',
      text: 'signin_with',
      locale: 'pl',
    });
  });
  document.head.append(script);
}

async function enter() {
  state.me = await api('GET', '/me');
  $('who-name').textContent = state.me.display_name;
  $('who').hidden = false;
  if (!state.me.is_admin) return show('view-denied');
  show('view-dashboard');
  await Promise.all([loadStats(), loadPeople(), loadSettings()]);
}

// ---- stats ----
async function loadStats() {
  const s = await api('GET', '/stats/network');
  const items = [
    ['Osoby', s.members],
    ['Miejsca', s.places],
    ['Oceny', s.ratings],
    ['Gwiazdki w tym mies.', s.gold_stars_this_month],
  ];
  $('stats').replaceChildren(...items.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, fmtNumber(v)))));
}

// ---- people ----
async function loadPeople() {
  const list = await api('GET', '/admin/allowed');
  const joined = list.items.filter((i) => i.user).length;
  $('people-summary').textContent =
    `${list.items.length} na liście · ${list.admins} admin(ów) · ${joined} zalogowało się · ` +
    `${list.items.length - joined} czeka`;
  $('people-rows').replaceChildren(...list.items.map(personRow));
}

function personRow(p) {
  const isMe = p.email === state.me.email;
  const locked = p.from_environment || isMe;
  const initials = (p.user?.display_name ?? p.email).slice(0, 1).toUpperCase();
  const avatar = h(
    'span',
    { class: `avatar${p.role === 'admin' ? ' admin' : ''}`, 'aria-hidden': 'true' },
    p.user?.avatar_url ? h('img', { src: p.user.avatar_url, alt: '', referrerpolicy: 'no-referrer' }) : initials,
  );

  const who = h(
    'div',
    { class: 'person' },
    avatar,
    h(
      'div',
      {},
      h(
        'div',
        { class: 'person-name' },
        p.user?.display_name ?? 'Jeszcze się nie zalogował(a)',
        isMe && h('span', { class: 'badge' }, 'Ty'),
        p.from_environment && h('span', { class: 'badge badge-env', title: 'Ustawione w ADMIN_EMAILS' }, 'ENV'),
        !p.user && h('span', { class: 'badge badge-pending' }, 'Czeka'),
      ),
      h('div', { class: 'person-email' }, p.email),
    ),
  );

  const roleSelect = h(
    'select',
    {
      'aria-label': `Rola: ${p.email}`,
      disabled: locked && p.role === 'admin',
      title: locked && p.role === 'admin' ? 'Nie można zmienić' : null,
      onchange: async (e) => {
        try {
          await api('PATCH', `/admin/allowed/${encodeURIComponent(p.email)}`, { role: e.target.value });
          toast('Zmieniono rolę.');
        } catch (err) {
          fail(err);
        }
        await loadPeople();
      },
    },
    h('option', { value: 'member', selected: p.role === 'member' }, 'Członek'),
    h('option', { value: 'admin', selected: p.role === 'admin' }, 'Admin'),
  );

  const note = h('input', {
    class: 'note-input',
    type: 'text',
    maxlength: '200',
    value: p.note ?? '',
    'aria-label': `Notatka: ${p.email}`,
    onchange: async (e) => {
      try {
        await api('PATCH', `/admin/allowed/${encodeURIComponent(p.email)}`, { note: e.target.value.trim() || null });
        toast('Zapisano notatkę.');
      } catch (err) {
        fail(err);
      }
    },
  });

  const activity = p.user
    ? h(
        'div',
        { class: 'activity' },
        `${p.user.places} miejsc · ${p.user.ratings} ocen`,
        h('br'),
        `ostatnio ${fmtAgo(p.user.last_seen_at)}`,
      )
    : h(
        'div',
        { class: 'activity' },
        `dodano ${fmtAgo(p.created_at)}`,
        p.added_by && h('br'),
        p.added_by && `przez ${p.added_by.display_name}`,
      );

  const remove = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-danger btn-small',
      disabled: locked,
      title: p.from_environment ? 'Ustawione w ADMIN_EMAILS' : isMe ? 'To Ty' : null,
      onclick: async () => {
        const name = p.user?.display_name ?? p.email;
        if (!confirm(`Usunąć ${name} z listy? Straci dostęp od razu. Jego miejsca i oceny zostaną.`)) return;
        try {
          await api('DELETE', `/admin/allowed/${encodeURIComponent(p.email)}`);
          toast(`Usunięto ${name}.`);
        } catch (err) {
          fail(err);
        }
        await loadPeople();
      },
    },
    'Usuń',
  );

  return h(
    'tr',
    {},
    h('td', {}, who),
    h('td', {}, roleSelect),
    h('td', {}, note),
    h('td', {}, activity),
    h('td', {}, remove),
  );
}

$('add-person').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('add-email').value.trim();
  try {
    await api('POST', '/admin/allowed', {
      email,
      role: $('add-role').value,
      note: $('add-note').value.trim() || null,
    });
    e.target.reset();
    toast(`Dodano ${email}. Może się już zalogować.`);
    await loadPeople();
  } catch (err) {
    fail(err);
  }
});

// ---- settings ----
const UNITS = {
  maxPhotoBytes: (v) => `= ${(v / 1024 / 1024).toLocaleString('pl-PL', { maximumFractionDigits: 2 })} MB`,
};

async function loadSettings() {
  const { items } = await api('GET', '/admin/settings');
  $('settings-list').replaceChildren(...items.map(settingCard));
}

function settingCard(s) {
  const id = `setting-${s.key}`;
  const input = h('input', {
    id,
    type: 'number',
    value: String(s.value),
    min: s.min ?? null,
    max: s.max ?? null,
    step: s.integer ? '1' : '0.01',
    required: true,
  });
  const unit = UNITS[s.key] ? h('span', { class: 'setting-meta' }, UNITS[s.key](s.value)) : null;
  if (unit) input.addEventListener('input', () => (unit.textContent = UNITS[s.key](Number(input.value) || 0)));

  const save = async () => {
    try {
      await api('PUT', `/admin/settings/${s.key}`, { value: Number(input.value) });
      toast('Zapisano ustawienie.');
      await loadSettings();
    } catch (err) {
      fail(err);
    }
  };
  const reset = async () => {
    try {
      await api('DELETE', `/admin/settings/${s.key}`);
      toast('Przywrócono domyślną wartość.');
      await loadSettings();
    } catch (err) {
      fail(err);
    }
  };

  const changed = s.updated_at
    ? h(
        'span',
        { class: 'changed' },
        `Zmienione ${fmtDate(s.updated_at)}${s.updated_by ? ` przez ${s.updated_by.display_name}` : ''}`,
      )
    : 'Wartość domyślna';

  return h(
    'form',
    {
      class: 'setting',
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
    },
    h(
      'div',
      {},
      h('h2', {}, h('label', { for: id }, s.label)),
      h('p', {}, s.description),
      h(
        'div',
        { class: 'setting-meta' },
        `Domyślnie ${fmtNumber(s.default)} · zakres ${fmtNumber(s.min)}–${fmtNumber(s.max)} · `,
        changed,
      ),
    ),
    h(
      'div',
      { class: 'setting-control' },
      input,
      unit,
      h(
        'div',
        { class: 'setting-actions' },
        h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Zapisz'),
        h(
          'button',
          { type: 'button', class: 'btn btn-secondary btn-small', disabled: !s.updated_at, onclick: reset },
          'Domyślna',
        ),
      ),
    ),
  );
}

// ---- tabs ----
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) {
      const active = t === tab;
      t.setAttribute('aria-selected', String(active));
      $(`tab-${t.dataset.tab}`).hidden = !active;
    }
  });
}

$('sign-out').addEventListener('click', signOut);
$('dev-login').addEventListener('submit', (e) => {
  e.preventDefault();
  signInWith('/auth/dev', { email: $('dev-email').value.trim() });
});

// ---- start ----
(async function start() {
  try {
    state.meta = await api('GET', '/meta');
  } catch {
    state.meta = {};
  }
  state.token = store.get();
  if (!state.token) return showSignIn();
  try {
    await enter();
  } catch (err) {
    if (err.status !== 401) fail(err);
    if (!state.me) showSignIn();
  }
})();
