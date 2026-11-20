// Shared API helpers
async function api(path, opts = {}) {
  const token = sessionStorage.getItem('token');

  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && token) {
    sessionStorage.clear();
    location.href = '/';
  }

  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong');
  }

  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

let toastTimer;

function toast(message, isError) {
  let element = document.getElementById('toast');

  if (!element) {
    element = document.createElement('div');
    element.id = 'toast';
    document.body.appendChild(element);
  }

  element.textContent = message;
  element.className = 'show' + (isError ? ' error' : '');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.className = '';
  }, 3500);
}

function fmtDate(value) {
  return new Date(value.replace(' ', 'T') + 'Z').toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function requireRole(role) {
  if (sessionStorage.getItem('role') !== role) {
    location.href = '/';
  }
}

async function logout() {
  try {
    await api('/logout', { method: 'POST' });
  } catch {}

  sessionStorage.clear();
  location.href = '/';
}