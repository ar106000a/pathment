'use strict';

/**
 * A lead mentor seeing what they invited.
 *
 * Sending an invite into a clan has always been a mentor's to do. Seeing one
 * was not: listing, resending and revoking all sat behind invite.create, which
 * a mentor does not hold. So an invite went out and whether it landed, lapsed,
 * or had already been used could not be answered without asking an admin.
 *
 * These pin the three things that make the mentor side safe: the list is
 * scoped to one clan, the two actions refuse an invite from another clan
 * however it is addressed, and the shape carries the dates the phone turns into
 * a status.
 */

const request = require('supertest');
const app = require('../../src/index');
const { models } = require('../../src/db');
const {
  cleanDb,
  createAdmin,
  createMentor,
  createProgram,
  authHeader,
} = require('../helpers/seed');

let admin;
let lead;
let program;
let clan;
let otherClan;

async function makeClan(name) {
  return models.Clan.create({
    name,
    programId: program.id,
    createdBy: admin.id,
  });
}

async function makeInvite(email, clanId, patch = {}) {
  return models.RegistrationInvite.create({
    email,
    role: 'mentee',
    invitedBy: lead.id,
    tokenHash: `hash-${email}-${clanId}`,
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    programId: program.id,
    clanId,
    ...patch,
  });
}

beforeEach(async () => {
  await cleanDb();
  admin = await createAdmin({ email: 'invite-admin@test.com' });
  lead = await createMentor({ email: 'invite-lead@test.com' });
  program = await createProgram({ createdBy: admin.id, name: 'Backend' });
  clan = await makeClan('Node Guild');
  otherClan = await makeClan('React Guild');

  await models.ClanMembership.create({
    clanId: clan.id,
    userId: lead.id,
    role: 'lead_mentor',
    status: 'active',
  });
});

describe('the invites into a clan', () => {
  test('a lead mentor can list them, which needed an admin before', async () => {
    await makeInvite('waiting@test.com', clan.id);

    const response = await request(app)
      .get(`/api/clans/${clan.id}/invites`)
      .set('Authorization', authHeader(lead));

    expect(response.status).toBe(200);
    expect(response.body.data.invites).toHaveLength(1);
    expect(response.body.data.invites[0].email).toBe('waiting@test.com');
  });

  // The three dates the phone turns into one word. Losing any of them turns
  // every row into "Waiting" whatever actually happened to it.
  test('carries the dates a status is derived from', async () => {
    await makeInvite('waiting@test.com', clan.id);

    const response = await request(app)
      .get(`/api/clans/${clan.id}/invites`)
      .set('Authorization', authHeader(lead));

    const invite = response.body.data.invites[0];
    expect(invite).toHaveProperty('expiresAt');
    expect(invite).toHaveProperty('usedAt');
    expect(invite).toHaveProperty('revokedAt');
    expect(invite).toHaveProperty('createdAt');
  });

  test('shows the used and expired ones too, not only the live ones', async () => {
    await makeInvite('used@test.com', clan.id, { usedAt: new Date() });
    await makeInvite('gone@test.com', clan.id, {
      expiresAt: new Date(Date.now() - 3600 * 1000),
    });

    const response = await request(app)
      .get(`/api/clans/${clan.id}/invites`)
      .set('Authorization', authHeader(lead));

    expect(response.body.data.invites.map((one) => one.email).sort()).toEqual([
      'gone@test.com',
      'used@test.com',
    ]);
  });

  test('does not show another clan its neighbour invites', async () => {
    await makeInvite('theirs@test.com', otherClan.id);

    const response = await request(app)
      .get(`/api/clans/${clan.id}/invites`)
      .set('Authorization', authHeader(lead));

    expect(response.body.data.invites).toHaveLength(0);
  });

  test('refuses somebody who does not run the clan', async () => {
    const stranger = await createMentor({ email: 'stranger@test.com' });

    const response = await request(app)
      .get(`/api/clans/${clan.id}/invites`)
      .set('Authorization', authHeader(stranger));

    expect(response.status).toBe(403);
  });
});

describe('acting on one', () => {
  test('a lead mentor can send one again', async () => {
    const invite = await makeInvite('waiting@test.com', clan.id);

    const response = await request(app)
      .post(`/api/clans/${clan.id}/invites/${invite.id}/resend`)
      .set('Authorization', authHeader(lead));

    expect(response.status).toBe(200);
  });

  test('a lead mentor can pull one', async () => {
    const invite = await makeInvite('waiting@test.com', clan.id);

    const response = await request(app)
      .post(`/api/clans/${clan.id}/invites/${invite.id}/revoke`)
      .set('Authorization', authHeader(lead));

    expect(response.status).toBe(200);
    await invite.reload();
    expect(invite.revokedAt).not.toBeNull();
  });

  // The guard on the route only proves this person runs the clan in the path.
  // Without checking the invite belongs to it, an id is all it takes to act on
  // somebody else's.
  test('refuses an invite that belongs to another clan', async () => {
    const theirs = await makeInvite('theirs@test.com', otherClan.id);

    const resend = await request(app)
      .post(`/api/clans/${clan.id}/invites/${theirs.id}/resend`)
      .set('Authorization', authHeader(lead));
    const revoke = await request(app)
      .post(`/api/clans/${clan.id}/invites/${theirs.id}/revoke`)
      .set('Authorization', authHeader(lead));

    expect(resend.status).toBe(404);
    expect(revoke.status).toBe(404);
    await theirs.reload();
    expect(theirs.revokedAt).toBeNull();
  });
});

describe('sending one', () => {
  // Both of these are the whole reason the phone shows what the server said
  // rather than "Check the address and try again".
  test('lets an existing Pathment account receive another clan invite', async () => {
    const response = await request(app)
      .post(`/api/clans/${clan.id}/invite`)
      .set('Authorization', authHeader(lead))
      .send({ email: admin.email });

    expect(response.status).toBe(201);
    expect(response.body.data.invite.email).toBe(admin.email);
  });

  test('says plainly when an invite is already out', async () => {
    await makeInvite('twice@test.com', clan.id);

    const response = await request(app)
      .post(`/api/clans/${clan.id}/invite`)
      .set('Authorization', authHeader(lead))
      .send({ email: 'twice@test.com' });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/active invite/i);
  });
});
