"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  X,
  Clock,
  ListTodo,
  MessageSquare,
  Award,
  Trophy,
  Zap,
  ChevronRight,
  Users,
} from "lucide-react";
import { useAuth } from "@/lib/context/AuthContext";
import {
  matchesRole,
  roleFromPathname,
  type NotificationRole,
} from "@/lib/utils/notification-audience";
import {
  useNotificationFeed,
  toMessageText,
} from "@/lib/hooks/shared/useNotificationFeed";
import { useClan, ALL_CLANS } from "@/lib/context/ClanContext";
import { logicalPathname, workspacePath } from "@/lib/services/workspace-scope";
import { completionApi, type StandingRequest } from "@/lib/services/program-completion-api";
import { useProgramCloseoutEnabled } from "@/lib/hooks/useProgramCloseoutEnabled";
import {
  StandingClanDecisionButtons,
  StandingClanDecisionDrawer,
  STANDING_CLAN_UPGRADE_COPY,
  type StandingClanReview,
} from "@/components/shared/StandingClanDecisionDrawer";
import { NotificationCard } from "@/components/shared/NotificationCard";

interface Notification {
  id: string;
  type: string;
  audience?: "mentor" | "mentee" | "admin" | "any";
  title: string;
  message: string;
  status: "unread" | "read" | "archived";
  actionUrl?: string;
  actionLabel?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  clanId?: string | null;
  createdAt: string;
  readAt?: string;
}

interface NotificationDrawerProps {
  userId: string;
  showLabel?: boolean;
}

// Per-type icon + tint so notifications are scannable at a glance.
const TYPE_ICON: Record<string, { Icon: typeof Bell; cls: string }> = {
  task: { Icon: ListTodo, cls: "bg-brand-50 text-brand-600" },
  feedback: { Icon: MessageSquare, cls: "bg-violet-50 text-violet-600" },
  badge: { Icon: Award, cls: "bg-amber-50 text-amber-600" },
  milestone: { Icon: Trophy, cls: "bg-emerald-50 text-emerald-600" },
  message: { Icon: MessageSquare, cls: "bg-sky-50 text-sky-600" },
  system: { Icon: Bell, cls: "bg-slate-100 text-slate-500" },
  challenge: { Icon: Zap, cls: "bg-orange-50 text-orange-600" },
};
const typeMeta = (t?: string) => TYPE_ICON[t || "system"] || TYPE_ICON.system;

const getRoleNotificationsPath = (pathname: string): string => {
  const role = roleFromPathname(pathname);
  if (role === "admin" || role === "mentor" || role === "mentee") {
    return `/${role}/notifications`;
  }
  return "/notifications";
};

export default function NotificationDrawer({
  userId,
  showLabel = false,
}: NotificationDrawerProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const pathname = logicalPathname(usePathname());
  const { activeRole } = useAuth();
  const { activeClanId, menteeActiveClanId } = useClan();
  const closeoutEnabled = useProgramCloseoutEnabled();
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [showAllRoles, setShowAllRoles] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [pendingStanding, setPendingStanding] = useState<StandingRequest[]>([]);
  const [standingReview, setStandingReview] = useState<StandingClanReview | null>(null);
  // The feed itself is shared: this bell renders twice (desktop sidebar + mobile
  // header) and both are always in the DOM, so owning the state here meant two
  // of every fetch and two sockets. See useNotificationFeed.
  const { notifications, loading, reload, markRead, markAllRead, remove } =
    useNotificationFeed(userId);
  // Only blank the list when there is genuinely nothing to show; a background
  // refresh must not replace a populated list with a spinner.
  const isLoading = loading && notifications.length === 0;

  const notificationsPath = getRoleNotificationsPath(pathname || "");

  // Scope to the role the viewer is currently in: prefer the active-role toggle,
  // fall back to the portal in the URL, else show everything. A dual-role
  // mentor/mentee sees only the active hat's items; single-role users see all
  // theirs (they never receive the other role's notifications).
  const role: NotificationRole | null =
    (activeRole as NotificationRole) || roleFromPathname(pathname);
  const isAdminDrawer = role === "admin";
  const roleScoped = useMemo(
    () => notifications.filter((n) => matchesRole(n.audience, role)),
    [notifications, role],
  );
  const clanScoped = useMemo(() => {
    const portalClan =
      role === "mentee"
        ? menteeActiveClanId
        : role === "mentor"
          ? activeClanId
          : null;
    if (!portalClan || portalClan === ALL_CLANS) return roleScoped;
    return roleScoped.filter((n) => !n.clanId || n.clanId === portalClan);
  }, [roleScoped, role, menteeActiveClanId, activeClanId]);
  const scopedNotifications = showAllRoles ? notifications : clanScoped;
  const visibleNotifications = scopedNotifications.filter(
    (notification) => filter === "all" || notification.status === "unread",
  );
  // Standing requests are shown as cards with Approve/Reject above the feed.
  // Hide the matching feed rows so admins do not see the same request twice.
  const pendingStandingIds = useMemo(
    () => new Set(pendingStanding.map((row) => row.id)),
    [pendingStanding],
  );
  const feedNotifications = visibleNotifications.filter(
    (n) =>
      !(
        n.relatedEntityType === "standing_clan_request" &&
        n.relatedEntityId &&
        pendingStandingIds.has(n.relatedEntityId)
      ),
  );
  const unreadCount = useMemo(
    () => clanScoped.filter((item) => item.status === "unread").length,
    [clanScoped],
  );
  const hiddenOtherRoleCount = notifications.length - roleScoped.length;

  // Ensure we only render portal on client.
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Opening the drawer asks for a fresh read; the cache serves the current list
  // meanwhile, so there is no spinner over existing data.
  useEffect(() => {
    if (isOpen) reload();
  }, [isOpen, reload]);

  // Admin only: load open standing-clan requests for the Approve/Reject cards.
  const loadPendingStanding = useCallback(async () => {
    if (!isAdminDrawer) {
      setPendingStanding([]);
      return;
    }
    try {
      const rows = await completionApi.requests();
      setPendingStanding(
        (Array.isArray(rows) ? rows : []).filter((r) => r.status === "pending"),
      );
    } catch {
      // Feed should still work if this request fails.
      setPendingStanding([]);
    }
  }, [isAdminDrawer]);

  useEffect(() => {
    if (isOpen && isAdminDrawer) void loadPendingStanding();
  }, [isOpen, isAdminDrawer, loadPendingStanding]);

  // Lock background scroll while sheet is open.
  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const handleMarkRead = (notificationId: string) => markRead(notificationId);
  const handleMarkAllRead = () => markAllRead();
  const handleDelete = (notificationId: string) => remove(notificationId);

  const handleNotificationClick = (notification: Notification) => {
    // Standing requests: decide with the card buttons above, not by navigating away.
    if (
      isAdminDrawer &&
      notification.relatedEntityType === "standing_clan_request" &&
      notification.relatedEntityId
    ) {
      if (notification.status === "unread") handleMarkRead(notification.id);
      return;
    }
    // Normal notification: open its link (if any) and mark as read.
    if (notification.actionUrl) {
      router.push(workspacePath(notification.actionUrl));
      setIsOpen(false);
    }
    if (notification.status === "unread") {
      handleMarkRead(notification.id);
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  // Keep keyboard focus inside the open sheet and return it to the bell.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
      if (event.key !== "Tab") return;
      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], [tabindex="0"]',
        ) || [],
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [isOpen]);

  return (
    <>
      {/* Notification Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative rounded-xl transition-colors duration-200 ${
          showLabel
            ? "w-full flex items-center gap-3 px-3 py-2.5 text-left"
            : "p-2"
        } ${
          isOpen
            ? "bg-brand-50 text-brand-700"
            : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
        }`}
        aria-label={`Notifications ${unreadCount > 0 ? `(${unreadCount} unread)` : ""}`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title="Open notifications"
      >
        <span className="relative shrink-0">
          <Bell className={showLabel ? "w-4 h-4" : "w-5 h-5"} />
          {unreadCount > 0 && (
            <span className="absolute -top-2 -right-2 flex items-center justify-center min-w-5 h-5 px-1 bg-red-500 text-white text-xs font-bold rounded-full">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </span>
        {showLabel && (
          <span className="text-sm font-medium">Notifications</span>
        )}
      </button>

      {isMounted &&
        isOpen &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-70 bg-black/30 dark:bg-black/60 lg:left-64"
              onClick={() => setIsOpen(false)}
              aria-hidden="true"
            />

            <aside
              ref={dialogRef}
              className="fixed right-0 top-0 z-80 h-dvh w-full max-w-lg bg-card shadow-2xl border-l border-slate-200 dark:border-slate-700 flex flex-col"
              role="dialog"
              aria-labelledby="notif-title"
              aria-modal="true"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-border">
                <div>
                  <h2
                    id="notif-title"
                    className="text-base font-semibold text-slate-900"
                  >
                    Notifications
                  </h2>
                  <p className="text-sm text-slate-500">
                    {unreadCount > 0
                      ? `${unreadCount} unread`
                      : "All caught up"}
                    {role && (
                      <span className="capitalize">
                        {" "}
                        · {showAllRoles ? "all roles" : role}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                  aria-label="Close notifications"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Role scope toggle — only meaningful for dual-role users who actually
                have other-role notifications to reveal. */}
              {role && (showAllRoles || hiddenOtherRoleCount > 0) && (
                <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">
                    {showAllRoles
                      ? "Showing notifications for all your roles"
                      : `${hiddenOtherRoleCount} from your other role${hiddenOtherRoleCount === 1 ? "" : "s"} hidden`}
                  </span>
                  <button
                    onClick={() => setShowAllRoles((v) => !v)}
                    className="text-xs font-medium text-brand-600 hover:text-brand-700 shrink-0"
                  >
                    {showAllRoles ? `Show only ${role}` : "Show all"}
                  </button>
                </div>
              )}

              <div className="flex gap-2 border-b border-border p-4">
                {(["all", "unread"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={`rounded-full px-4 py-2 text-sm font-medium capitalize ${filter === value ? "bg-brand-600 text-white" : "bg-muted text-muted-foreground"}`}
                  >
                    {value === "all"
                      ? "All updates"
                      : `Unread (${scopedNotifications.filter((item) => item.status === "unread").length})`}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto bg-muted/30 p-3">
                {/* Same NotificationCard as the feed, but with Approve / Reject actions. */}
                {isAdminDrawer && pendingStanding.length > 0 && (
                  <div className="mb-3 space-y-2">
                    <p className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                      Standing clan requests
                    </p>
                    {pendingStanding.map((row) => (
                      <NotificationCard
                        key={row.id}
                        unread
                        title={row.name}
                        message={
                          row.description?.trim()
                            || `${row.program.name} · ${row.mentor.firstName} ${row.mentor.lastName}`
                        }
                        meta={
                          row.description?.trim()
                            ? `${row.program.name} · ${row.mentor.firstName} ${row.mentor.lastName}`
                            : undefined
                        }
                        icon={<Users className="w-4 h-4" />}
                        iconClassName="bg-amber-50 text-amber-700"
                        actions={
                          <StandingClanDecisionButtons
                            row={row}
                            disabled={!closeoutEnabled}
                            title={!closeoutEnabled ? STANDING_CLAN_UPGRADE_COPY : undefined}
                            onReview={setStandingReview}
                            onDecided={() => {
                              void loadPendingStanding();
                              reload();
                            }}
                          />
                        }
                      />
                    ))}
                  </div>
                )}
                {isLoading ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-2">
                    <Clock className="w-6 h-6 animate-spin" />
                    <span>Loading notifications...</span>
                  </div>
                ) : feedNotifications.length === 0 && pendingStanding.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-2 px-6 text-center">
                    <Bell className="w-8 h-8 text-slate-300" />
                    <span>
                      {filter === "unread"
                        ? "You’re all caught up"
                        : role && !showAllRoles
                          ? `No ${role} notifications`
                          : "No notifications yet"}
                    </span>
                    {role && !showAllRoles && hiddenOtherRoleCount > 0 && (
                      <button
                        onClick={() => setShowAllRoles(true)}
                        className="text-xs font-medium text-brand-600 hover:text-brand-700"
                      >
                        Show {hiddenOtherRoleCount} from your other role
                        {hiddenOtherRoleCount === 1 ? "" : "s"}
                      </button>
                    )}
                  </div>
                ) : feedNotifications.length === 0 ? null : (
                  <div className="space-y-3">
                    {/* Normal notifications: same card, mark-read / delete instead of actions. */}
                    {feedNotifications.map((notification) => {
                      const { Icon, cls } = typeMeta(notification.type);
                      return (
                        <NotificationCard
                          key={notification.id}
                          unread={notification.status === "unread"}
                          title={notification.title}
                          message={toMessageText(notification.message)}
                          icon={<Icon className="w-4 h-4" />}
                          iconClassName={cls}
                          onClick={() => handleNotificationClick(notification)}
                          onMarkRead={
                            notification.status === "unread"
                              ? () => handleMarkRead(notification.id)
                              : undefined
                          }
                          onDelete={() => handleDelete(notification.id)}
                          meta={
                            <>
                              <span>{formatTime(notification.createdAt)}</span>
                              {notification.actionUrl && notification.actionLabel ? (
                                <span className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-600">
                                  · {notification.actionLabel}{" "}
                                  <ChevronRight className="w-3 h-3" />
                                </span>
                              ) : null}
                            </>
                          }
                        />
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="p-3 border-t border-slate-200 bg-card">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={handleMarkAllRead}
                    className="px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                  >
                    Mark all as read
                  </button>
                  <button
                    onClick={() => {
                      router.push(workspacePath(notificationsPath));
                      setIsOpen(false);
                    }}
                    className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
                  >
                    View all
                  </button>
                </div>
              </div>
            </aside>
            <StandingClanDecisionDrawer
              review={standingReview}
              zClass="z-[90]"
              onClose={() => setStandingReview(null)}
              onDecided={() => {
                void loadPendingStanding();
                reload();
              }}
            />
          </>,
          document.body,
        )}
    </>
  );
}

export { NotificationDrawer };
