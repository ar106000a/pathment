function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();

  if (normalized === undefined || normalized === '') {
    return fallback;
  }

  return !['0', 'false', 'no', 'off'].includes(normalized);
}

export const siteConfig = {
  name: 'Pathment',
  description: 'AI-Powered Mentorship Platform',
  url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  links: {
    github: 'https://github.com/Sheryar-Ahmed/pathment',
  },
};

export const profilePhotoConfig = {
  requireProfilePhoto: parseBooleanEnv(process.env.NEXT_PUBLIC_REQUIRE_PROFILE_PHOTO, true),
};

export const navigationConfig = {
  admin: [
    {
      title: 'Dashboard',
      href: '/admin/dashboard',
      icon: 'LayoutDashboard',
    },
    {
      title: 'Programs',
      href: '/admin/programs/list',
      icon: 'BookOpen',
    },
    {
      title: 'Enrollment',
      href: '/admin/enrollment/overview',
      icon: 'Users',
    },
    {
      title: 'Matching',
      href: '/admin/matching/mentor-assignment',
      icon: 'UserCheck',
    },
  ],
  mentor: [
    {
      title: 'Dashboard',
      href: '/mentor/dashboard',
      icon: 'LayoutDashboard',
    },
    {
      title: 'Mentees',
      href: '/mentor/mentees',
      icon: 'Users',
    },
    {
      title: 'Tasks',
      href: '/mentor/tasks/assign',
      icon: 'CheckSquare',
    },
    {
      title: 'Review Queue',
      href: '/mentor/review-queue',
      icon: 'Inbox',
    },
  ],
  mentee: [
    {
      title: 'Dashboard',
      href: '/mentee/dashboard',
      icon: 'LayoutDashboard',
    },
    {
      title: 'Tasks',
      href: '/mentee/tasks/list',
      icon: 'CheckSquare',
    },
    {
      title: 'Feedback',
      href: '/mentee/feedback',
      icon: 'MessageSquare',
    },
  ],
};
