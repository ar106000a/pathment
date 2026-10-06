'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, Loader2, Plus, ArrowRight } from 'lucide-react';
import { useAuth } from '@/lib/context/AuthContext';
import { apiClient } from '@/lib/services/api-client';
import type { OrganizationSummary } from '@/lib/services/organizations-api';
import { switchWorkspace } from '@/lib/services/workspace-scope';
import { useApiQuery } from '@/lib/query/useApiQuery';
import { CreateWorkspaceDrawer } from '@/components/settings/OrganizationSettingsTab';
import { tokenStore } from '@/lib/services/token-store';

export default function WorkspacesPage() {
  const { user, isLoading } = useAuth();
  const hasSession = Boolean(tokenStore.getToken());
  const [creating, setCreating] = useState(false);
  const { data, loading, error, refetch } = useApiQuery({
    queryKey: ['account-workspaces', user?.id ?? 'account'],
    enabled: hasSession,
    queryFn: () => apiClient.get<{ data: { organizations: OrganizationSummary[]; workspaceCreationEnabled: boolean } }>('/organizations/me').then(response => response.data),
    errorMessage: 'Could not load your workspaces',
  });
  const workspaces = data?.organizations ?? [];
  const canCreate = data?.workspaceCreationEnabled ?? false;

  if (isLoading && hasSession) return <div role="status" className="grid min-h-screen place-items-center"><Loader2 className="h-6 w-6 animate-spin" /><span className="sr-only">Loading account</span></div>;

  return <main className="mx-auto min-h-screen max-w-2xl px-6 py-16">
    <h1 className="text-3xl font-semibold text-foreground">Your workspaces</h1>
    <p className="mt-3 text-muted-foreground">One Pathment account. Separate people, programs, and roles in every workspace.</p>
    {!hasSession ? <Link href="/" className="mt-8 inline-flex rounded-xl bg-brand-600 px-5 py-3 font-medium text-white">Choose your workspace</Link> : <>
      {loading ? <p role="status" className="mt-8 text-muted-foreground">Loading workspaces…</p> : error ? <div role="alert" className="mt-8 rounded-xl border border-border p-5"><p>{error}</p><button onClick={() => void refetch()} className="mt-3 font-medium text-brand-600">Try again</button></div> : <div className="mt-8 space-y-3">
        {workspaces.map(workspace => <button key={workspace.id} onClick={() => switchWorkspace(workspace.slug)} className="flex w-full items-center gap-4 rounded-xl border border-border bg-card p-5 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
          <Building2 className="h-6 w-6 shrink-0 text-brand-600" aria-hidden="true" />
          <span className="min-w-0 flex-1"><span className="block font-semibold text-foreground">{workspace.name}</span><span className="block text-sm text-muted-foreground">/w/{workspace.slug} · {workspace.membershipRole}</span></span>
          <ArrowRight className="h-5 w-5 shrink-0" aria-hidden="true" />
        </button>)}
        {!workspaces.length && <p className="rounded-xl border border-border p-5 text-muted-foreground">You haven’t joined a workspace yet. Accept an invitation or create your own.</p>}
      </div>}
      {canCreate && <button onClick={() => setCreating(true)} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-3 font-medium text-white hover:bg-brand-700"><Plus className="h-4 w-4" aria-hidden="true" />Create workspace</button>}
      {!loading && !error && !canCreate && <p className="mt-6 text-sm text-muted-foreground">New workspace creation is not currently available.</p>}
      {creating && canCreate && <CreateWorkspaceDrawer onClose={() => setCreating(false)} onCreated={switchWorkspace} />}
    </>}
  </main>;
}
