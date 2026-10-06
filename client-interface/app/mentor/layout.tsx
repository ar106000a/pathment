import '@/styles/mentor-appearance.css';
import { MentorWorkspaceTabs } from '@/components/mentor/MentorWorkspaceTabs';
import { Navigation } from '@/components/shared/Navigation';
import { RoleGuard } from '@/components/shared/RoleGuard';
import OnboardingGuard from '@/components/shared/OnboardingGuard';
import { ActivityTrackerMount } from '@/components/shared/ActivityTrackerMount';
import { TimezoneSync } from '@/components/shared/TimezoneSync';
import { WalkthroughMount } from '@/components/onboarding/WalkthroughMount';
import { ChangelogMount } from '@/components/shared/ChangelogMount';
import { ClanWorkspaceNotice } from '@/components/shared/ClanWorkspaceNotice';

export default function MentorLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGuard allowedRoles={['mentor']}>
      <OnboardingGuard>
        <div data-mentor-appearance className="min-h-screen bg-canvas">
          <ActivityTrackerMount />
          <TimezoneSync />
          <WalkthroughMount role="mentor" />
          <ChangelogMount role="mentor" />
          <Navigation role="mentor" />
          <main className="lg:pl-64 pt-14 lg:pt-0">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"><MentorWorkspaceTabs /><ClanWorkspaceNotice role="mentor" />{children}</div>
          </main>
        </div>
      </OnboardingGuard>
    </RoleGuard>
  );
}
