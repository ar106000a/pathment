"use client";

import type { ReactNode } from "react";
import { Bell, Check, Trash2 } from "lucide-react";
import { cn } from "@/components/ui/utils";

interface NotificationCardProps {
  title: string;
  message?: string;
  /** Extra line under the message, e.g. "3d ago · Review >". */
  meta?: ReactNode;
  /** Left icon. Falls back to a bell if omitted. */
  icon?: ReactNode;
  iconClassName?: string;
  unread?: boolean;
  onClick?: () => void;
  onMarkRead?: () => void;
  onDelete?: () => void;
  /**
   * Optional right-side buttons (e.g. Approve / Reject).
   * When set, mark-read and delete icons are hidden.
   */
  actions?: ReactNode;
  className?: string;
}

/**
 * One notification row. Same look everywhere.
 *
 * - Normal feed: pass onMarkRead / onDelete (check + trash on the right).
 * - Standing requests: pass actions={Approve/Reject buttons} instead.
 */
export function NotificationCard({
  title,
  message,
  meta,
  icon,
  iconClassName = "bg-slate-100 text-slate-500",
  unread = false,
  onClick,
  onMarkRead,
  onDelete,
  actions,
  className,
}: NotificationCardProps) {
  return (
    <div
      className={cn(
        "group rounded-2xl border border-border px-4 py-4 transition-colors",
        onClick && "cursor-pointer",
        unread
          ? "bg-brand-50 dark:bg-brand-500/10 hover:bg-brand-100 dark:hover:bg-brand-500/20"
          : "bg-card hover:bg-slate-50",
        className,
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        {/* Left icon tile */}
        <div
          className={cn(
            "w-9 h-9 rounded-xl flex items-center justify-center shrink-0",
            iconClassName,
          )}
        >
          {icon ?? <Bell className="w-4 h-4" aria-hidden />}
        </div>

        {/* Title, body, and optional meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {onClick ? (
              <button
                type="button"
                className="text-left text-sm font-semibold text-foreground leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                onClick={(event) => {
                  event.stopPropagation();
                  onClick();
                }}
              >
                {title}
              </button>
            ) : (
              <p className="text-sm font-semibold text-foreground leading-snug">{title}</p>
            )}
            {unread && (
              <span className="w-2 h-2 rounded-full bg-brand-600 shrink-0" aria-hidden />
            )}
          </div>

          {message ? (
            <p className="mt-2 text-sm text-muted-foreground line-clamp-3 leading-relaxed">
              {message}
            </p>
          ) : null}

          {meta ? (
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">{meta}</div>
          ) : null}
        </div>

        {/* Right side: custom actions OR mark-read / delete */}
        {actions ? (
          <div
            className="shrink-0 flex flex-wrap items-start justify-end gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
        ) : onMarkRead || onDelete ? (
          <div className="shrink-0 flex items-center gap-1">
            {unread && onMarkRead ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onMarkRead();
                }}
                className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-100 rounded"
                aria-label="Mark notification read"
              >
                <Check className="w-4 h-4" />
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-100 rounded"
                aria-label="Delete notification"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
