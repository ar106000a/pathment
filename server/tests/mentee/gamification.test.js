'use strict';

const request = require('supertest');
const app = require('../../src/index');
const { models } = require('../../src/db');
const {
  cleanDb,
  createAdmin,
  createMentee,
  authHeader,
} = require('../helpers/seed');

describe('Mentee gamification challenges', () => {
  let admin;
  let mentee;

  beforeEach(async () => {
    await cleanDb();
    admin = await createAdmin();
    mentee = await createMentee();
  });

  it('returns joined challenges newest enrollment first', async () => {
    const now = Date.now();
    const olderChallenge = await models.Challenge.create({
      createdBy: admin.id,
      title: 'Seven day consistency',
      description: 'Log progress for seven days.',
      type: 'consistency',
      requirements: { days: 7 },
      pointsReward: 100,
      startDate: new Date(now - 24 * 60 * 60 * 1000),
      endDate: new Date(now + 14 * 24 * 60 * 60 * 1000),
    });
    const newerChallenge = await models.Challenge.create({
      createdBy: admin.id,
      title: 'Finish two tasks',
      description: 'Complete two roadmap tasks this week.',
      type: 'speed',
      requirements: { tasks: 2 },
      pointsReward: 75,
      startDate: new Date(now - 24 * 60 * 60 * 1000),
      endDate: new Date(now + 7 * 24 * 60 * 60 * 1000),
    });

    await models.UserChallenge.create({
      userId: mentee.id,
      challengeId: olderChallenge.id,
      enrolledAt: new Date(now - 60 * 60 * 1000),
    });
    await models.UserChallenge.create({
      userId: mentee.id,
      challengeId: newerChallenge.id,
      enrolledAt: new Date(now),
    });

    const response = await request(app)
      .get(`/api/gamification/challenges/user/${mentee.id}`)
      .set('Authorization', authHeader(mentee));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.userChallenges).toHaveLength(2);
    expect(response.body.data.userChallenges.map(({ challengeId }) => challengeId)).toEqual([
      newerChallenge.id,
      olderChallenge.id,
    ]);
  });
});
