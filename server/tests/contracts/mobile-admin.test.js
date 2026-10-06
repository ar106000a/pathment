'use strict';

/**
 * What the mobile app reads, pinned to what the API sends.
 *
 * These are not tests of behaviour. They are tests of shape, and they exist
 * because shape is where the mobile client kept going wrong: eight separate
 * fields were being read that no endpoint has ever returned, and every one of
 * them rendered as a blank or a nought on a screen whose whole job was showing
 * it. Nothing failed. Nothing logged. A clan simply said "No lead, 0 mentees"
 * for as long as the screen had existed.
 *
 * TypeScript on the client cannot catch that, because the client's type is the
 * assumption being tested. Only the server can say what it sends, so it says it
 * here: change one of these field names and this fails, rather than a screen
 * quietly going blank in somebody's hand.
 */

const request = require('supertest');
const app = require('../../src/index');
const { models } = require('../../src/db');
const {
  cleanDb,
  createAdmin,
  createMentor,
  createMentee,
  createProgram,
  createEnrollment,
  authHeader,
} = require('../helpers/seed');

let admin;
let mentor;
let program;

beforeEach(async () => {
  await cleanDb();
  admin = await createAdmin({ email: 'contract-admin@test.com' });
  mentor = await createMentor({ email: 'contract-mentor@test.com' });
  program = await createProgram({ createdBy: admin.id, name: 'Frontend' });
});

describe('the cohort list', () => {
  test('names the programme through an object, and counts per status', async () => {
    // The client read `programName` and `acceptedCount`. Neither is sent: the
    // programme arrives through the include, and the counts are per status.
    const cohort = await models.Cohort.create({
      programId: program.id,
      name: 'Autumn 2026',
      status: 'open',
      createdBy: admin.id,
      levels: [{ key: 'beginner', label: 'Just starting' }],
    });
    await models.Application.create({
      cohortId: cohort.id, email: 'a@test.com', firstName: 'Amina', lastName: 'Yusuf',
      status: 'accepted', source: 'manual',
    });

    const res = await request(app)
      .get('/api/intake/cohorts')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    const row = res.body.data.cohorts.find((one) => one.id === cohort.id);

    expect(row.program).toEqual(expect.objectContaining({ name: 'Frontend' }));
    expect(row.programName).toBeUndefined();
    expect(row.applicationsByStatus).toEqual(expect.objectContaining({ accepted: 1 }));
    expect(row.acceptedCount).toBeUndefined();
    expect(row.enrolledCount).toBeUndefined();
    expect(row.applicationsOpen).toBeUndefined();

    // Levels are objects with a key and a label. The key is what a pool row and
    // an applicant's level are stored against; the label is the readable half.
    expect(row.levels).toEqual([{ key: 'beginner', label: 'Just starting' }]);
  });
});

describe('the application list', () => {
  test('carries first and last name, and the mark as maxScore', async () => {
    const cohort = await models.Cohort.create({
      programId: program.id, name: 'Autumn', status: 'open', createdBy: admin.id,
    });
    await models.Application.create({
      cohortId: cohort.id, email: 'omar@test.com', firstName: 'Omar', lastName: 'Farouk',
      source: 'manual',
    });

    const res = await request(app)
      .get(`/api/intake/cohorts/${cohort.id}/applications`)
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    const [row] = res.body.data.applications;

    expect(row.firstName).toBe('Omar');
    expect(row.lastName).toBe('Farouk');
    expect(row).toHaveProperty('maxScore');
    // The client looked for these three. None of them is sent.
    expect(row.applicantName).toBeUndefined();
    expect(row.fullName).toBeUndefined();
    expect(row.score).toBeUndefined();
  });
});

describe('the clan health snapshot', () => {
  test('is where the counts and the lead actually live', async () => {
    // GET /clans returns rows with none of this, which is what the admin
    // screens were reading. This endpoint has it worked out already.
    const clan = await models.Clan.create({
      programId: program.id, name: 'Falcons', leadMentorId: mentor.id, status: 'active',
      createdBy: admin.id,
    });

    const res = await request(app)
      .get('/api/clans/health')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    const card = res.body.data.programs
      .flatMap((one) => one.clans)
      .find((one) => one.id === clan.id);

    expect(card.leadMentor).toEqual(expect.objectContaining({ name: expect.any(String) }));
    expect(card.leadName).toBeUndefined();
    expect(card.medianProgress).toBeUndefined();
    expect(card).toEqual(expect.objectContaining({
      memberCount: expect.any(Number),
      avgCompletion: expect.any(Number),
      atRisk: expect.any(Number),
      statusLabel: expect.any(String),
      statusReason: expect.any(String),
    }));

    // Program rows are the dashboard's selectable scopes. They carry their own
    // exact snapshot so choosing one updates every chart and KPI, not only the
    // clan table.
    const programScope = res.body.data.programs.find((one) => one.id === program.id);
    expect(programScope).toEqual(expect.objectContaining({
      status: program.status,
      memberCount: expect.any(Number),
      avgCompletion: expect.any(Number),
      avgOnTime: expect.any(Number),
      openBlockers: expect.any(Number),
      pendingApprovals: expect.any(Number),
      summary: expect.objectContaining({
        risk: expect.objectContaining({ high: expect.any(Number), watch: expect.any(Number), low: expect.any(Number) }),
        completion: expect.any(Array),
      }),
      priorityMentees: expect.any(Array),
    }));
  });
});

describe('the invite list', () => {
  test('says what happened with dates, not with a status field', async () => {
    // `status` is a filter this endpoint takes, not a column it returns. Read
    // as a field it was always undefined, so every invite showed "waiting",
    // used ones included, and the screen offered to revoke them.
    await models.RegistrationInvite.create({
      email: 'invited@test.com', role: 'mentee', tokenHash: 'x'.repeat(64),
      invitedBy: admin.id, expiresAt: new Date(Date.now() + 86400000),
    });

    const res = await request(app)
      .get('/api/admin/invites')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    const [row] = res.body.data.invites;

    expect(row).toHaveProperty('usedAt');
    expect(row).toHaveProperty('expiresAt');
    expect(row.status).toBeUndefined();
    expect(row.acceptedAt).toBeUndefined();
  });
});

describe('the rewards shelf', () => {
  test('prices a gift in costXp', async () => {
    // Read as `pointsCost` it was undefined, so every gift showed 0 pts and
    // `balance >= undefined` was false: nothing was ever claimable.
    await models.Gift.create({ name: 'A hoodie', costXp: 500, active: true, createdBy: admin.id });

    const res = await request(app)
      .get('/api/rewards')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    const [gift] = res.body.data.gifts;

    expect(gift.costXp).toBe(500);
    expect(gift.pointsCost).toBeUndefined();
    // No balance rides along here, which is why the screen asks for it
    // separately rather than falling back to lifetime points earned.
    expect(res.body.data.balance).toBeUndefined();
  });

  test('refuses a claim that does not name the mentee', async () => {
    const gift = await models.Gift.create({
      name: 'A hoodie', costXp: 0, active: true, createdBy: admin.id,
    });

    const res = await request(app)
      .post('/api/rewards/redeem')
      .set('Authorization', authHeader(admin))
      .send({ giftId: gift.id });

    expect(res.status).toBe(400);
  });

  test('lets a mentee read the shelf, read their balance and claim for themselves', async () => {
    const mentee = await createMentee({ email: 'reward-mentee@test.com' });
    await createEnrollment({ menteeId: mentee.id, programId: program.id });
    const gift = await models.Gift.create({
      name: 'A notebook', costXp: 0, active: true, createdBy: admin.id,
    });

    const shelf = await request(app)
      .get('/api/rewards')
      .set('Authorization', authHeader(mentee))
      .set('X-Portal-Role', 'mentee');
    const balance = await request(app)
      .get(`/api/rewards/balance/${mentee.id}`)
      .set('Authorization', authHeader(mentee))
      .set('X-Portal-Role', 'mentee');
    const claim = await request(app)
      .post('/api/rewards/redeem')
      .set('Authorization', authHeader(mentee))
      .set('X-Portal-Role', 'mentee')
      .send({ giftId: gift.id, menteeId: mentee.id });

    expect(shelf.status).toBe(200);
    expect(shelf.body.data.gifts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: gift.id, costXp: 0 }),
    ]));
    expect(shelf.body.data.redemptions).toEqual([]);
    expect(balance.status).toBe(200);
    expect(balance.body.data).toEqual({ earned: 0, spent: 0, balance: 0 });
    expect(claim.status).toBe(201);
  });

  test('does not let a mentee claim a reward for somebody else', async () => {
    const mentee = await createMentee({ email: 'claiming-mentee@test.com' });
    const other = await createMentee({ email: 'other-mentee@test.com' });
    const gift = await models.Gift.create({
      name: 'A notebook', costXp: 0, active: true, createdBy: admin.id,
    });

    const res = await request(app)
      .post('/api/rewards/redeem')
      .set('Authorization', authHeader(mentee))
      .set('X-Portal-Role', 'mentee')
      .send({ giftId: gift.id, menteeId: other.id });

    expect(res.status).toBe(403);
  });
});

describe('the application pipeline', () => {
  test('starts an application at pending, and has no status called submitted', async () => {
    // The client filtered this list on "submitted" and made it the default tab
    // of the screen an admin opens to work through applications. The endpoint
    // filters on exactly what it is given, so the queue was empty however many
    // people were waiting in it.
    const cohort = await models.Cohort.create({
      programId: program.id, name: 'Autumn', status: 'open', createdBy: admin.id,
    });
    const application = await models.Application.create({
      cohortId: cohort.id, email: 'new@test.com', source: 'public_link',
    });

    expect(application.status).toBe('pending');

    const submitted = await request(app)
      .get(`/api/intake/cohorts/${cohort.id}/applications`)
      .query({ status: 'submitted' })
      .set('Authorization', authHeader(admin));

    expect(submitted.status).toBe(200);
    expect(submitted.body.data.applications).toEqual([]);

    const pending = await request(app)
      .get(`/api/intake/cohorts/${cohort.id}/applications`)
      .query({ status: 'pending' })
      .set('Authorization', authHeader(admin));

    expect(pending.body.data.applications).toHaveLength(1);
  });

  test('refuses a status the client invented', async () => {
    // Which is the other half of it: the client's list of statuses had to come
    // from somewhere, and it was not from here.
    const cohort = await models.Cohort.create({
      programId: program.id, name: 'Autumn', status: 'open', createdBy: admin.id,
    });

    await expect(
      models.Application.create({ cohortId: cohort.id, email: 'x@test.com', source: 'manual', status: 'submitted' })
    ).rejects.toThrow();
  });
});

describe('an org roadmap save', () => {
  test('rebuilds every step from the payload, resources included', async () => {
    // The trap the mobile editor had to be written around: PUT rewrites each
    // step from what it is given and deletes and recreates its resources, so a
    // payload carrying only the fields one screen edits silently strips the
    // links somebody attached on another.
    const created = await request(app)
      .post('/api/roadmaps/org')
      .set('Authorization', authHeader(admin))
      .send({
        programId: program.id,
        name: 'Frontend basics',
        steps: [{
          title: 'Build the form',
          description: 'Wire it up',
          criteria: ['It submits'],
          resources: [{ url: 'https://example.com', title: 'The docs' }],
        }],
      });

    expect(created.status).toBe(201);
    const roadmap = created.body.data.roadmap;
    const [step] = roadmap.steps;

    expect(step.acceptanceCriteria).toEqual(['It submits']);
    expect(step.resources).toHaveLength(1);

    // Saving the step back without its resources loses them. This is the
    // behaviour, not a bug to fix here: it is why the client round trips the
    // whole step rather than the part it edits.
    const stripped = await request(app)
      .put(`/api/roadmaps/org/${roadmap.id}/steps`)
      .set('Authorization', authHeader(admin))
      .send({ steps: [{ id: step.id, title: 'Build the form' }] });

    expect(stripped.status).toBe(200);
    expect(stripped.body.data.roadmap.steps[0].resources).toHaveLength(0);
  });
});

describe('an assessment save', () => {
  test('keeps the option ids the correct answers point at', async () => {
    // Correct answers are stored as option ids. Minting new ids on save would
    // unmark every right answer and say nothing.
    const created = await request(app)
      .post('/api/assessments')
      .set('Authorization', authHeader(admin))
      .send({ title: 'Intake, spring' });

    expect(created.status).toBe(201);
    const id = created.body.data.assessment.id;

    const saved = await request(app)
      .put(`/api/assessments/${id}/questions`)
      .set('Authorization', authHeader(admin))
      .send({
        questions: [{
          type: 'mcq',
          prompt: 'Which one?',
          points: 2,
          options: [{ id: 'o1', label: 'This' }, { id: 'o2', label: 'That' }],
          correctOptionIds: ['o1'],
        }],
      });

    expect(saved.status).toBe(200);
    const [question] = saved.body.data.assessment.questions;

    expect(question.options.map((one) => one.id)).toEqual(['o1', 'o2']);
    expect(question.correctOptionIds).toEqual(['o1']);
  });

  test('will not publish an assessment with nothing in it', async () => {
    const created = await request(app)
      .post('/api/assessments')
      .set('Authorization', authHeader(admin))
      .send({ title: 'Empty' });

    const published = await request(app)
      .patch(`/api/assessments/${created.body.data.assessment.id}`)
      .set('Authorization', authHeader(admin))
      .send({ status: 'published' });

    expect(published.status).toBe(400);
  });
});

describe('a schedule template', () => {
  test('stores a block as a label, a time and a set of days', async () => {
    // Not a day with a start and an end, which is what the client had, so both
    // screens showing a rhythm drew an empty week and said "0h a week".
    const created = await request(app)
      .post('/api/schedules/org')
      .set('Authorization', authHeader(admin))
      .send({
        name: 'Build week',
        blocks: [{ label: 'Standup', time: '9:00 AM', days: 'weekdays', bookable: false }],
      });

    expect(created.status).toBe(201);
    const [block] = created.body.data.template.blocks;

    expect(block).toEqual(expect.objectContaining({
      label: 'Standup', time: '9:00 AM', days: 'weekdays',
    }));
    expect(block.start).toBeUndefined();
    expect(block.end).toBeUndefined();
    expect(block.day).toBeUndefined();
  });
});

describe('a scoped role grant', () => {
  test('refuses a clan scope with no clan named', async () => {
    // The grant sheet offered "one clan" and sent no id, so this is what came
    // back: a refusal about a selection the screen never offered.
    const res = await request(app)
      .post('/api/access/grants')
      .set('Authorization', authHeader(admin))
      .send({ userId: mentor.id, role: 'intake_manager', scopeType: 'clan' });

    expect(res.status).toBe(400);
  });
});

describe('an invite', () => {
  test('will not go out without the placement its role needs', async () => {
    // A mentee is invited into a programme and a mentor is invited to lead a
    // clan. The phone's invite sheet asked which programme for a mentee and
    // asked a mentor nothing, so every mentor invite came back naming a field
    // the screen had never offered.
    const noClan = await request(app)
      .post('/api/admin/invites')
      .set('Authorization', authHeader(admin))
      .send({ email: 'lead@test.com', role: 'mentor' });

    expect(noClan.status).toBe(400);
    expect(noClan.body.message).toMatch(/clan/i);

    const noProgramme = await request(app)
      .post('/api/admin/invites')
      .set('Authorization', authHeader(admin))
      .send({ email: 'learner@test.com', role: 'mentee' });

    expect(noProgramme.status).toBe(400);
    expect(noProgramme.body.message).toMatch(/program/i);
  });

  test('goes out once the placement is named', async () => {
    const clan = await models.Clan.create({
      programId: program.id, name: 'Falcons', status: 'active', createdBy: admin.id,
    });

    const res = await request(app)
      .post('/api/admin/invites')
      .set('Authorization', authHeader(admin))
      .send({ email: 'lead@test.com', role: 'mentor', clanId: clan.id });

    expect(res.status).toBe(201);
  });
});
