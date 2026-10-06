const { models } = require('../db');
const { NotFoundError, ForbiddenError, ValidationError } = require('../utils/errors/errorTypes');
const { todayInZone } = require('../utils/timezone');
const authzService = require('./authzService');
const clanLifecycleService = require('./clanLifecycleService');

/** How long after its day an entry stays editable. */
const EDIT_WINDOW_HOURS = 48;
const MAX_NOTE_LENGTH = 2000;

/**
 * taskProgressService - a mentee's day-by-day notes on one assigned task.
 *
 * The point of the feature is not "did they finish", it is "is this going badly
 * and can we tell before the deadline". A four day task with nothing written on
 * days one and two IS the signal, so gaps are preserved and surfaced rather than
 * collapsed away.
 *
 * Writing progress also upserts the day's DailyLogEntry, so logging on the task
 * counts toward the streak. That is the point of putting it here: the daily log
 * stops being a chore on a separate page and happens where the work happens.
 */
class TaskProgressService {
  /** Today's calendar day in the MENTEE's own timezone, never UTC and never the client's word. */
  async _todayFor(menteeId) {
    const settings = await models.UserSettings.findOne({ where: { userId: menteeId }, attributes: ['timezone'] });
    return todayInZone(settings?.timezone || 'UTC');
  }

  /** Whole days between two 'YYYY-MM-DD' keys. Date arithmetic on a label, so UTC is correct here. */
  _daysBetween(fromKey, toKey) {
    const a = new Date(`${fromKey}T00:00:00Z`).getTime();
    const b = new Date(`${toKey}T00:00:00Z`).getTime();
    return Math.round((b - a) / 86400000);
  }

  /**
   * The task, if this mentee owns it. Ownership is checked against the task's
   * menteeId, not against "is a mentee" - otherwise any mentee could write on
   * anyone's task.
   */
  async _ownedTask(menteeId, assignedTaskId) {
    const task = await models.AssignedTask.findByPk(assignedTaskId, {
      // organizationId: tenant guard; enrollmentId: frozen-program fallback when clanId is null.
      attributes: ['id', 'organizationId', 'menteeId', 'clanId', 'enrollmentId', 'status', 'dueDate', 'assignedAt', 'startedAt'],
    });
    if (!task) throw new NotFoundError('Task not found');
    if (task.menteeId !== menteeId) throw new ForbiddenError('This task is not yours');
    return task;
  }

  /**
   * Record or replace today's progress on a task.
   *
   * Upsert rather than append: several entries in one day turns a timeline into
   * a chat log and makes "logged 3 of 4 days" meaningless.
   */
  async log(menteeId, assignedTaskId, { note, minutesSpent = null } = {}) {
    const text = typeof note === 'string' ? note.trim() : '';
    if (!text) throw new ValidationError('Write a line about what you did');
    if (text.length > MAX_NOTE_LENGTH) {
      throw new ValidationError(`Keep it under ${MAX_NOTE_LENGTH} characters`);
    }

    const task = await this._ownedTask(menteeId, assignedTaskId);
    await clanLifecycleService.assertTaskWritable(task);
    // Nothing to log on work that is already finished or was never started.
    if (['completed', 'cancelled'].includes(task.status)) {
      throw new ValidationError('This task is closed, so there is no progress to add');
    }

    const dateKey = await this._todayFor(menteeId);
    const minutes = minutesSpent == null ? null : Math.max(0, Math.min(24 * 60, parseInt(minutesSpent, 10) || 0));

    const existing = await models.TaskProgressEntry.findOne({ where: { assignedTaskId, dateKey } });
    let entry;
    if (existing) {
      await existing.update({ note: text, minutesSpent: minutes });
      entry = existing;
    } else {
      entry = await models.TaskProgressEntry.create({
        assignedTaskId, menteeId, dateKey, note: text, minutesSpent: minutes,
      });
    }

    // Working on a task IS showing up that day. Upserting the daily log here is
    // what lets the streak count it, and is the reason this lives on the task
    // rather than on a separate page.
    //
    // Deliberately not fatal: a streak is worth less than the note it counts,
    // and refusing to save somebody's progress because a badge check threw would
    // be the wrong way round.
    try {
      await this._creditDay(menteeId, dateKey, task.clanId);
    } catch (error) {
      console.error('[taskProgress] Could not credit the day:', error.message);
    }

    // A task with progress on it is in progress, whatever it said before.
    if (task.status === 'assigned') {
      await task.update({ status: 'in_progress', startedAt: task.startedAt || new Date() });
    }

    return this._shape(entry);
  }

  /**
   * Make sure the day exists in the daily log, then recount the streak.
   * Does NOT touch `tasksDone`: that array means "ticked complete today", which
   * is a different fact from "worked on it today". Conflating them would put two
   * meanings in one column.
   */
  async _creditDay(menteeId, dateKey, clanId) {
    const [day, created] = await models.DailyLogEntry.findOrCreate({
      where: { menteeId, dateKey, clanId: clanId || null },
      defaults: { menteeId, dateKey, clanId: clanId || null, tasksDone: [], slotsDone: [], note: null },
    });
    if (!created) await day.update({ loggedAt: new Date() });
    await require('./gamificationService').updateStreak(menteeId);
  }

  /**
   * The timeline for a task, oldest first, with the empty days left IN.
   *
   * The gaps are the signal. A mentor seeing three filled days and one hollow one
   * learns more than any status field, so this returns the full span from the day
   * work started to today (or the due date, whichever is later) rather than only
   * the days that have an entry.
   */
  async listForTask(assignedTaskId, { menteeId } = {}) {
    const task = await models.AssignedTask.findByPk(assignedTaskId, {
      attributes: ['id', 'menteeId', 'assignedAt', 'startedAt', 'dueDate', 'status'],
    });
    if (!task) throw new NotFoundError('Task not found');

    const entries = await models.TaskProgressEntry.findAll({
      where: { assignedTaskId },
      order: [['dateKey', 'ASC']],
    });

    const today = await this._todayFor(menteeId || task.menteeId);
    const keyOf = (d) => new Date(d).toISOString().split('T')[0];

    // The window: from the first thing that happened, to today or the deadline.
    const firstEntry = entries.length ? entries[0].dateKey : null;
    const started = task.startedAt ? keyOf(task.startedAt) : (task.assignedAt ? keyOf(task.assignedAt) : today);
    let from = firstEntry && firstEntry < started ? firstEntry : started;
    let to = today;
    if (task.dueDate) {
      const due = keyOf(task.dueDate);
      if (due > to) to = due;
    }
    // Guard against a silly span if assignedAt is far in the past.
    const MAX_DAYS = 30;
    if (this._daysBetween(from, to) > MAX_DAYS) {
      from = this._shift(to, -MAX_DAYS);
    }

    const byDate = new Map(entries.map((e) => [e.dateKey, e]));
    const days = [];
    for (let cursor = from; cursor <= to; cursor = this._shift(cursor, 1)) {
      const entry = byDate.get(cursor);
      days.push({
        dateKey: cursor,
        isToday: cursor === today,
        isFuture: cursor > today,
        entry: entry ? this._shape(entry) : null,
      });
    }

    const loggedDays = entries.length;
    const elapsed = days.filter((d) => !d.isFuture).length;
    return {
      days,
      summary: {
        loggedDays,
        elapsedDays: elapsed,
        // The sentence a mentor actually reads on the review screen.
        label: elapsed > 0 ? `logged ${loggedDays} of ${elapsed} day${elapsed === 1 ? '' : 's'}` : 'not started',
        lastNote: entries.length ? entries[entries.length - 1].note : null,
        lastLoggedOn: entries.length ? entries[entries.length - 1].dateKey : null,
      },
    };
  }

  _shift(dateKey, offsetDays) {
    const d = new Date(`${dateKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().split('T')[0];
  }

  /** The mentor's read. Same data, and the same permission the rest of the mentor surface uses. */
  async listForMentor(user, assignedTaskId) {
    const task = await models.AssignedTask.findByPk(assignedTaskId, { attributes: ['id', 'menteeId'] });
    if (!task) throw new NotFoundError('Task not found');
    if (!(await authzService.canViewMentee(user, task.menteeId))) {
      throw new ForbiddenError('You do not mentor this person');
    }
    return this.listForTask(assignedTaskId, { menteeId: task.menteeId });
  }

  /**
   * Remove one entry, within the edit window.
   *
   * Frozen after 48 hours on purpose: long enough to fix a typo or backfill
   * yesterday, short enough that it stays a log rather than a document somebody
   * tidies up before review. The honesty is the value.
   */
  async remove(menteeId, assignedTaskId, dateKey) {
    const task = await this._ownedTask(menteeId, assignedTaskId);
    await clanLifecycleService.assertTaskWritable(task);
    const entry = await models.TaskProgressEntry.findOne({ where: { assignedTaskId, dateKey } });
    if (!entry) throw new NotFoundError('No progress logged for that day');

    const today = await this._todayFor(menteeId);
    if (this._daysBetween(entry.dateKey, today) * 24 > EDIT_WINDOW_HOURS) {
      throw new ValidationError('That day is locked. Progress can only be changed for about two days.');
    }
    await entry.destroy();
    return { removed: true, dateKey };
  }

  /**
   * A one line progress read per in-flight task, for the cohort review screen.
   *
   * This is where the feature earns its keep: the mentor is already going person
   * by person, and "logged 3 of 4 days, last: stuck on the refresh flow" turns a
   * status into a conversation opener at no extra cost to them.
   *
   * Kept cheap on purpose. One query for the tasks, one for every entry across
   * them, then counted in memory. No N+1 across a 20 person clan.
   */
  async summaryForMentee(menteeId, { limit = 3, clanId = null } = {}) {
    const { Op } = require('sequelize');
    const where = { menteeId, status: { [Op.in]: ['assigned', 'in_progress', 'revision_needed'] } };
    // Clan review must not surface open work from another clan (e.g. completed
    // cohort history on a fresh standing-clan mentee).
    if (clanId) where.clanId = clanId;
    const tasks = await models.AssignedTask.findAll({
      where,
      attributes: ['id', 'roadmapTaskId', 'dueDate', 'startedAt', 'assignedAt'],
      include: [{ model: models.RoadmapTask, as: 'roadmapTask', attributes: ['title'], required: false }],
      order: [['dueDate', 'ASC NULLS LAST']],
      limit,
    });
    if (!tasks.length) return [];

    const taskIds = tasks.map((t) => t.id);
    const entries = await models.TaskProgressEntry.findAll({
      where: { assignedTaskId: { [Op.in]: taskIds } },
      attributes: ['assignedTaskId', 'dateKey', 'note'],
      order: [['dateKey', 'ASC']],
      raw: true,
    });

    const byTask = new Map(taskIds.map((id) => [id, []]));
    entries.forEach((e) => byTask.get(e.assignedTaskId)?.push(e));

    const today = await this._todayFor(menteeId);
    return tasks.map((t) => {
      const rows = byTask.get(t.id) || [];
      const startKey = t.startedAt || t.assignedAt
        ? new Date(t.startedAt || t.assignedAt).toISOString().split('T')[0]
        : today;
      // Days that have actually elapsed, capped so an old assignment does not
      // read as "logged 2 of 90 days" and look like a catastrophe.
      const elapsed = Math.max(1, Math.min(30, this._daysBetween(startKey, today) + 1));
      const last = rows.length ? rows[rows.length - 1] : null;
      return {
        taskId: t.id,
        title: t.roadmapTask?.title || 'Task',
        loggedDays: rows.length,
        elapsedDays: elapsed,
        label: rows.length ? `logged ${rows.length} of ${elapsed} day${elapsed === 1 ? '' : 's'}` : 'nothing logged yet',
        lastNote: last ? last.note : null,
        lastLoggedOn: last ? last.dateKey : null,
      };
    });
  }

  _shape(entry) {
    return {
      id: entry.id,
      dateKey: entry.dateKey,
      note: entry.note,
      minutesSpent: entry.minutesSpent,
      loggedAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }
}

module.exports = new TaskProgressService();
