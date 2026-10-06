'use strict';

/**
 * A streak milestone is paid once.
 *
 * It was not. The award was decided by `milestonesCrossed(previous, current)`,
 * where `previous` is the counter on the mentee profile — and that counter goes
 * to zero whenever a streak breaks, or whenever a recount lands on a day before
 * the mentee has logged. Whatever the cause, the next call asked "what lies
 * between 0 and 60" and paid 7, 14, 30 and 60 all over again.
 *
 * Production, before this fix: 8,250 points across eleven mentees. One was paid
 * the seven-day bonus eight times. The mentee at the top of the leaderboard
 * showed 3,276 points and had genuinely earned 1,326 — 2,600 of her total was
 * streak bonuses against 141 points of completed work, which is what made the
 * board meaningless to everyone below her.
 *
 * What has been paid is now read from the ledger, so no counter can re-open it.
 */

const gamificationService = require('../../src/services/gamificationService');
const dailyLogService = require('../../src/services/dailyLogService');
const { models } = require('../../src/db');
const { shiftDayKey, STREAK_BONUSES } = require('../../src/services/streak');
const { cleanDb, createMentee } = require('../helpers/seed');
const { todayInZone } = require('../../src/utils/timezone');

const TODAY = () => todayInZone('UTC');

async function logDays(menteeId, count, endingOn = TODAY()) {
  for (let index = count - 1; index >= 0; index -= 1) {
    await dailyLogService.upsert(menteeId, {
      dateKey: shiftDayKey(endingOn, -index),
      tasksDone: [], slotsDone: [], note: 'Worked on it',
    });
  }
}

const streakRows = (menteeId) => models.PointsHistory.findAll({
  where: { userId: menteeId, sourceType: 'streak_bonus' }, raw: true
});

describe('streak milestone bonuses are paid once', () => {
  let mentee;

  beforeEach(async () => {
    await cleanDb();
    mentee = await createMentee();
    await models.MenteeProfile.findOrCreate({ where: { userId: mentee.id } });
    await models.UserSettings.findOrCreate({
      where: { userId: mentee.id }, defaults: { timezone: 'UTC' },
    });
  });

  it('pays the seven day bonus when the streak reaches seven', async () => {
    await logDays(mentee.id, 7);
    await gamificationService.updateStreak(mentee.id);

    const rows = await streakRows(mentee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].points_change ?? rows[0].pointsChange).toBe(STREAK_BONUSES[7]);
  });

  it('pays nothing extra when the streak is recounted the same day', async () => {
    await logDays(mentee.id, 7);
    await gamificationService.updateStreak(mentee.id);
    await gamificationService.updateStreak(mentee.id);
    await gamificationService.updateStreak(mentee.id);

    expect(await streakRows(mentee.id)).toHaveLength(1);
  });

  /**
   * The exact production failure. Zeroing the counter is what a broken streak
   * and an early recount both do, so this reproduces either.
   */
  it('does NOT pay again after the stored counter is reset to zero', async () => {
    await logDays(mentee.id, 30);
    await gamificationService.updateStreak(mentee.id);
    const afterFirst = await streakRows(mentee.id);
    expect(afterFirst).toHaveLength(3);          // 7, 14 and 30

    await models.MenteeProfile.update(
      { currentStreakDays: 0 }, { where: { userId: mentee.id } }
    );
    await gamificationService.updateStreak(mentee.id);

    const afterReset = await streakRows(mentee.id);
    expect(afterReset).toHaveLength(3);
    const total = afterReset.reduce((sum, r) => sum + (r.points_change ?? r.pointsChange), 0);
    expect(total).toBe(STREAK_BONUSES[7] + STREAK_BONUSES[14] + STREAK_BONUSES[30]);
  });

  it('still pays a NEW milestone once the run gets longer', async () => {
    await logDays(mentee.id, 7);
    await gamificationService.updateStreak(mentee.id);
    expect(await streakRows(mentee.id)).toHaveLength(1);

    await logDays(mentee.id, 14);
    await gamificationService.updateStreak(mentee.id);

    const rows = await streakRows(mentee.id);
    expect(rows).toHaveLength(2);                 // 7 and now 14, never 7 twice
    const paid = rows.map((r) => r.points_change ?? r.pointsChange).sort((a, b) => a - b);
    expect(paid).toEqual([STREAK_BONUSES[7], STREAK_BONUSES[14]]);
  });
});

describe('an unranked mentee is not given a rank', () => {
  let mentee;

  beforeEach(async () => {
    await cleanDb();
    mentee = await createMentee();
    await models.MenteeProfile.findOrCreate({ where: { userId: mentee.id } });
  });

  /**
   * The rank was "how many profiles hold more points than you, plus one". With
   * 550 people on the board and 503 mentees on zero, everyone who had earned
   * nothing was told they were 551st — a number that counts the people ahead
   * and ignores the five hundred level with them.
   */
  it('reports no rank for somebody who has earned nothing', async () => {
    const stats = await gamificationService.getUserGamificationStats(mentee.id);
    expect(stats.totalPoints).toBe(0);
    expect(stats.leaderboardRank).toBeNull();
  });

  it('does not invent a progress rank from points alone', async () => {
    await gamificationService.awardPoints(mentee.id, 20, 'task_completed', null, 'a task');

    const stats = await gamificationService.getUserGamificationStats(mentee.id);
    expect(stats.totalPoints).toBe(20);
    expect(stats.leaderboardRank).toBeNull();
  });
});
