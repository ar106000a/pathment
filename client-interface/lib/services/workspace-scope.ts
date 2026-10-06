export const RESERVED_WORKSPACES = new Set(['pathment', 'www', 'app', 'api', 'links', 'meet', 'staging', 'status', 'support', 'admin', 'mail', 'cdn', 'assets']);
export function validWorkspaceSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) && !value.startsWith('api-') && !RESERVED_WORKSPACES.has(value);
}

const KEY = 'pathment-active-workspace';
const PATH = /^\/w\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?=\/|$)/i;

export function workspaceSlugFromPathname(pathname: string): string | null {
  const slug = pathname.match(PATH)?.[1]?.toLowerCase();
  return validWorkspaceSlug(slug) ? slug : null;
}

export function logicalPathname(pathname: string): string {
  const match = pathname.match(PATH);
  if (!match) return pathname || '/';
  const rest = pathname.slice(match[0].length);
  return rest.startsWith('/') ? rest : (rest ? `/${rest}` : '/');
}

export function legacyWorkspaceFromHostname(host: string): string | null {
  if (!host.endsWith('.pathment.me')) return null;
  const slug = host.slice(0, -'.pathment.me'.length);
  return validWorkspaceSlug(slug) ? slug : null;
}

export function activeWorkspaceSlug(): string | null {
  if (typeof window === 'undefined') return null;
  // An explicitly invalid workspace must never fall back to a remembered tenant.
  if (window.location.pathname.startsWith('/w/')) return workspaceSlugFromPathname(window.location.pathname);
  const legacy = legacyWorkspaceFromHostname(window.location.hostname.toLowerCase());
  if (legacy) return legacy;
  // Match the workspace selected by the routing proxy. Old unscoped links can
  // otherwise resurrect a stale localStorage choice after an explicit visit.
  if (typeof document !== 'undefined') {
    const selected = document.cookie.split(';').map(value => value.trim())
      .find(value => value.startsWith('pathment-workspace='))?.slice('pathment-workspace='.length);
    if (validWorkspaceSlug(selected)) return selected;
  }
  try {
    const remembered = localStorage.getItem(KEY);
    return validWorkspaceSlug(remembered) ? remembered : null;
  } catch { return null; }
}

export function workspacePath(path: string, slug = activeWorkspaceSlug()): string {
  if (!path || !validWorkspaceSlug(slug) || /^(?:[a-z]+:|#|\/\/)/i.test(path) || PATH.test(path)) return path;
  return `/w/${slug}${path.startsWith('/') ? path : `/${path}`}`;
}

type WorkspaceUser = {
  role: 'admin' | 'mentor' | 'mentee';
  capabilities?: Array<'admin' | 'mentor' | 'mentee'>;
};

/** Resolve the first authenticated screen without bouncing through `/`. */
export function workspaceLandingPath(user: WorkspaceUser): string {
  const capabilities = user.capabilities ?? [user.role];
  let stored: WorkspaceUser['role'] | null = null;
  try {
    const value = localStorage.getItem('activeRole');
    if (value === 'admin' || value === 'mentor' || value === 'mentee') stored = value;
  } catch { /* The user's account role remains a safe fallback. */ }
  const role = stored && capabilities.includes(stored)
    ? stored
    : capabilities.includes(user.role)
      ? user.role
      : capabilities[0];
  return workspacePath(role ? `/${role}/dashboard` : '/workspaces');
}

export function workspaceScopeHeaders(): Record<string, string> {
  const slug = activeWorkspaceSlug();
  return slug ? { 'X-Pathment-Workspace': slug } : {};
}

export function switchWorkspace(slug: string): void {
  if (typeof window === 'undefined') return;
  if (!validWorkspaceSlug(slug)) throw new Error('Invalid workspace');
  try { localStorage.setItem(KEY, slug); } catch { /* URL remains authoritative. */ }
  const host = window.location.hostname.toLowerCase();
  const local = host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const origin = local ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || 'https://app.pathment.me');
  const path = logicalPathname(window.location.pathname);
  // Record ids and role areas from the previous workspace need not exist here.
  // `/w/:slug` renders the account entry page. Sending a signed-in user there
  // caused it to bounce back to the workspace chooser. The scoped login route
  // already resolves a valid session to the correct active-role dashboard.
  const destination = path === '/workspace-preview' ? path : '/login';
  window.location.assign(`${origin}/w/${slug}${destination}`);
}
