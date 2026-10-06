'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, Loader2 } from 'lucide-react';
import { tokenStore } from '@/lib/services/token-store';
import { organizationsApi } from '@/lib/services/organizations-api';
import { activeWorkspaceSlug, switchWorkspace, validWorkspaceSlug } from '@/lib/services/workspace-scope';

export default function HomePage() {
  const router = useRouter();
  const [hasSession] = useState(() => Boolean(tokenStore.getToken()));
  const [workspace, setWorkspace] = useState('');
  const rawWorkspace = workspace.trim().toLowerCase();
  const slug = rawWorkspace.match(/(?:^|\/)w\/([a-z0-9-]+)(?:\/|$)/)?.[1]
    ?? rawWorkspace.match(/^([a-z0-9-]+)\.pathment\.me(?:\/|$)/)?.[1]
    ?? rawWorkspace.replace(/^https?:\/\//, '').replace(/^app\.pathment\.me\//, '').replace(/^\/|\/$/g, '');

  useEffect(() => {
    if (!hasSession) return;

    let active = true;
    const openAccount = async () => {
      try {
        const workspaces = await organizationsApi.mine();
        if (!active) return;

        const remembered = activeWorkspaceSlug();
        const destination = workspaces.find(item => item.slug === remembered)
          ?? (workspaces.length === 1 ? workspaces[0] : null);

        if (destination) switchWorkspace(destination.slug);
        else router.replace('/workspaces');
      } catch {
        if (!active) return;
        // Do not strand an existing session during a temporary account lookup
        // failure. The workspace-scoped auth check remains authoritative.
        const remembered = activeWorkspaceSlug();
        if (remembered) switchWorkspace(remembered);
        else router.replace('/workspaces');
      }
    };

    void openAccount();
    return () => { active = false; };
  }, [hasSession, router]);

  const openWorkspace = (event: FormEvent) => {
    event.preventDefault();
    if (!validWorkspaceSlug(slug)) return;
    window.location.assign(`/w/${slug}/login`);
  };

  if (hasSession) return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );

  return <main className="grid min-h-screen place-items-center bg-muted/20 px-6 py-16">
    <div className="w-full max-w-lg rounded-3xl border border-border bg-card p-8 shadow-sm sm:p-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white">
        <Building2 className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="mt-6 text-3xl font-semibold text-foreground">Open your Pathment workspace</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Each workspace keeps its people, programs, and roles separate. Enter the workspace from your invitation or organization.
      </p>
      <form onSubmit={openWorkspace} className="mt-8 space-y-3">
        <label htmlFor="workspace" className="block text-sm font-medium text-foreground">Workspace URL</label>
        <div className="flex rounded-xl border border-border bg-background focus-within:ring-2 focus-within:ring-brand-500">
          <span className="flex items-center pl-4 text-sm text-muted-foreground">app.pathment.me/w/</span>
          <input id="workspace" autoFocus value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="your-workspace" className="min-w-0 flex-1 bg-transparent px-1 py-3 pr-4 text-sm outline-none" />
        </div>
        <button type="submit" disabled={!validWorkspaceSlug(slug)} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-3 font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">
          Continue <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </form>
      <p className="mt-6 text-center text-xs text-muted-foreground">New here? Open the invitation your workspace administrator sent you.</p>
    </div>
  </main>;
}
