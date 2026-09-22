(() => {
  const logout = document.getElementById('admin-logout');
  const status = document.getElementById('admin-session-status');
  if (!(logout instanceof HTMLButtonElement) || !(status instanceof HTMLElement)) return;

  const csrfToken = () => {
    const prefix = 'mbl_admin_csrf=';
    const item = document.cookie
      .split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix));
    if (!item) return '';
    try {
      return decodeURIComponent(item.slice(prefix.length));
    } catch {
      return '';
    }
  };

  const redirectToLogin = () => {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/admin/login?next=${encodeURIComponent(next)}`);
  };

  const checkSession = async () => {
    try {
      const response = await fetch('/api/admin/auth/session', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) {
        redirectToLogin();
        return;
      }
      const expiresAt = Date.parse(String(payload.expiresAt || ''));
      status.textContent = Number.isFinite(expiresAt)
        ? `Сессия активна до ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(expiresAt)}`
        : 'Сессия активна';
    } catch {
      status.textContent = 'Не удалось проверить срок сессии.';
    }
  };

  logout.addEventListener('click', async () => {
    const csrf = csrfToken();
    if (!csrf) {
      redirectToLogin();
      return;
    }
    logout.disabled = true;
    status.textContent = 'Завершаем сессию…';
    try {
      const response = await fetch('/api/admin/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrf, Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('LOGOUT_FAILED');
      window.location.assign('/admin/login');
    } catch {
      logout.disabled = false;
      status.textContent = 'Не удалось завершить сессию. Повторите попытку.';
    }
  });

  void checkSession();
})();
