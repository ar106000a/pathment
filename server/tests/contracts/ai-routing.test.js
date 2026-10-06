'use strict';

/**
 * Which key does which job.
 *
 * The phone could add an AI key and had no way to say what it was for, so an
 * organisation with a cheap key and an expensive one could not spend the
 * expensive one only where it matters, and nobody could see which key had
 * scored an applicant.
 *
 * The trap pinned here is that the server rewrites the routing map WHOLE: any
 * feature left out of the request comes back null. A client that sent only the
 * feature it had just changed would silently unroute the other eleven, and
 * nothing would look broken because an unrouted feature still falls back to a
 * working key.
 */

const request = require('supertest');
const app = require('../../src/index');
const { models } = require('../../src/db');
const { cleanDb, createAdmin, authHeader } = require('../helpers/seed');
const aiConnectionService = require('../../src/services/aiConnectionService');

let admin;

const read = () =>
  request(app).get('/api/ai-connections').set('Authorization', authHeader(admin));

const write = (routing) =>
  request(app)
    .put('/api/ai-connections/routing')
    .set('Authorization', authHeader(admin))
    .send({ routing });

async function addKey(label) {
  const response = await request(app)
    .post('/api/ai-connections')
    .set('Authorization', authHeader(admin))
    .send({ provider: 'groq', key: `test-key-${label}`, label, model: 'llama-3.1-8b-instant' });

  return response.body.data.connection;
}

beforeEach(async () => {
  await cleanDb();
  admin = await createAdmin({ email: 'ai-admin@test.com' });
});

describe('the features a key can be pointed at', () => {
  test('the server routes thirteen, and scoring applicants is one of them', async () => {
    // The phone's own list is asserted against this exact set in features.test.ts.
    expect(aiConnectionService.FEATURES).toContain('assessment');
    expect(aiConnectionService.FEATURES).toHaveLength(13);
  });

  test('every feature comes back in the routing, unset rather than absent', async () => {
    const response = await read();

    expect(response.status).toBe(200);
    for (const feature of aiConnectionService.FEATURES) {
      expect(response.body.data.routing).toHaveProperty(feature);
    }
  });
});

describe('pointing a feature at a key', () => {
  test('saves the choice and reads it back', async () => {
    const key = await addKey('Main key');

    const saved = await write({ assessment: key.id });

    expect(saved.status).toBe(200);
    expect(saved.body.data.routing.assessment).toBe(key.id);

    const back = await read();
    expect(back.body.data.routing.assessment).toBe(key.id);
  });

  // The whole reason the client sends the entire map every time.
  test('anything left out of the request is unrouted, not left alone', async () => {
    const cheap = await addKey('Cheap key');
    const main = await addKey('Main key');

    await write({ assessment: main.id, summary: cheap.id });

    // A client sending only the feature it changed would look like this.
    await write({ summary: cheap.id });

    const back = await read();
    expect(back.body.data.routing.summary).toBe(cheap.id);
    expect(back.body.data.routing.assessment).toBeNull();
  });

  test('sending the whole map keeps the others, which is what the phone does', async () => {
    const cheap = await addKey('Cheap key');
    const main = await addKey('Main key');

    const first = await write({ assessment: main.id, summary: cheap.id });
    const whole = { ...first.body.data.routing, roadmap: main.id };

    await write(whole);

    const back = await read();
    expect(back.body.data.routing.assessment).toBe(main.id);
    expect(back.body.data.routing.summary).toBe(cheap.id);
    expect(back.body.data.routing.roadmap).toBe(main.id);
  });

  test('clearing one back to any key stores null', async () => {
    const key = await addKey('Main key');
    await write({ assessment: key.id });

    const cleared = await write({ assessment: null });

    expect(cleared.body.data.routing.assessment).toBeNull();
  });

  test('ignores a feature name it does not know rather than storing it', async () => {
    const response = await write({ made_up_feature: 'anything' });

    expect(response.status).toBe(200);
    expect(response.body.data.routing).not.toHaveProperty('made_up_feature');
  });
});

describe('what an unrouted feature falls back to', () => {
  test('any connection, so nothing has to be routed for the AI to work', async () => {
    const key = await addKey('Only key');

    const config = await aiConnectionService.resolveActiveConfig('assessment', null);

    expect(config).toBeTruthy();
    expect(key.id).toBeTruthy();
  });

  test('nothing at all when no key has been added', async () => {
    const config = await aiConnectionService.resolveActiveConfig('assessment', null);
    expect(config).toBeNull();
  });
});

describe('the key itself', () => {
  test('never comes back after it is stored', async () => {
    await addKey('Main key');

    const response = await read();
    const row = response.body.data.connections[0];

    expect(row).not.toHaveProperty('key');
    expect(row).not.toHaveProperty('keyEncrypted');
    expect(JSON.stringify(row)).not.toContain('test-key-Main key');
  });
});
