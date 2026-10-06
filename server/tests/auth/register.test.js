'use strict';

/**
 * TC-M01  Register with valid invite token
 * TC-M02  Register with already-registered email
 * TC-M03  Register with weak password
 * TC-M04  Register with invalid email format
 * TC-M05  Register with all required fields empty
 */

const request = require('supertest');
const app = require('../../src/index');
const { cleanDb, createAdmin, createInviteToken } = require('../helpers/seed');

const BASE = '/api/auth/register';
let requestIp = 10;
const registerRequest = () => request(app).post(BASE)
  .set('X-Forwarded-For', `198.51.100.${requestIp}`);

describe('POST /api/auth/register — Registration', () => {
  let admin;
  let validToken;
  const targetEmail = 'awaisfatehali@gmail.com';

  beforeEach(async () => {
    requestIp += 1;
    await cleanDb();
    admin = await createAdmin();
    ({ rawToken: validToken } = await createInviteToken({ adminId: admin.id, role: 'mentee', email: targetEmail }));
  });

  // TC-M01
  it('TC-M01: creates account and returns 201 with a valid invite token', async () => {
    const res = await registerRequest().send({
      firstName: 'Awais',
      lastName: 'Fateh Ali',
      email: targetEmail,
      password: 'Test@1234!',
      confirmPassword: 'Test@1234!',
      inviteToken: validToken,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(targetEmail);
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  // TC-M02
  it('TC-M02: returns 409 when email is already registered', async () => {
    // First registration succeeds
    await registerRequest().send({
      firstName: 'Awais',
      lastName: 'Fateh Ali',
      email: targetEmail,
      password: 'Test@1234!',
      confirmPassword: 'Test@1234!',
      inviteToken: validToken,
    });

    // Second invite for the same email
    const { rawToken: secondToken } = await createInviteToken({
      adminId: admin.id,
      role: 'mentee',
      email: 'second@test.com',
    });

    // Try to re-register the already-used email with a fresh invite
    const { rawToken: freshToken } = await createInviteToken({
      adminId: admin.id,
      role: 'mentee',
      email: targetEmail,
    });

    const res = await registerRequest().send({
      firstName: 'Awais',
      lastName: 'Fateh Ali',
      email: targetEmail,
      password: 'Test@1234!',
      confirmPassword: 'Test@1234!',
      inviteToken: freshToken,
    });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message.toLowerCase()).toMatch(/already registered|already exists/i);
  });

  // TC-M03
  it('TC-M03: returns 400 when password is too weak', async () => {
    const { rawToken: token2 } = await createInviteToken({ adminId: admin.id, role: 'mentee', email: 'weak@test.com' });

    const res = await registerRequest().send({
      firstName: 'Weak',
      lastName: 'Pass',
      email: 'weak@test.com',
      password: '12345',
      confirmPassword: '12345',
      inviteToken: token2,
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message.toLowerCase()).toMatch(/password/i);
  });

  // TC-M04
  it('TC-M04: returns 400 for invalid email format', async () => {
    const res = await registerRequest().send({
      firstName: 'Awais',
      lastName: 'Test',
      email: 'awaisfatehali.edu',   // missing @
      password: 'Test@1234!',
      confirmPassword: 'Test@1234!',
      inviteToken: validToken,
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message.toLowerCase()).toMatch(/email/i);
  });

  // TC-M05
  it('TC-M05: returns 400 when all required fields are empty', async () => {
    const res = await registerRequest().send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
