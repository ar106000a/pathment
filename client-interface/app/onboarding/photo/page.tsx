'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/context/AuthContext';
import { ProfileImageUploader } from '@/components/shared/ProfileImageUploader';
import { profilePhotoConfig } from '@/lib/config/site';

/**
 * Mandatory profile-photo step. The OnboardingGuard sends any mentor/mentee
 * without a photo here (including existing users on their next login). When the
 * env flag is off, this route is skipped entirely and users continue directly.
 */
export default function OnboardingPhotoPage() {
  const router = useRouter();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!user) { router.replace('/login'); return; }
    const exempt = user.role !== 'mentor' && user.role !== 'mentee';
    if (!profilePhotoConfig.requireProfilePhoto || exempt || user.profilePictureUrl) {
      router.replace(`/${user.role}/dashboard`);
    }
  }, [user, isLoading, router]);

  return (
    <div className="min-h-screen bg-canvas flex flex-col items-center justify-center px-4">
      
      <ProfileImageUploader
        open
        required
        title="Add your profile photo"
        onUploaded={() => router.push(`/${user?.role}/dashboard`)}
      />
    </div>
  );
}
