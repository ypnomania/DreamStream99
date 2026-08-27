import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mediaErrorMessage,
  MediaRecoveryController,
  MediaRecoveryExhaustedError,
  isRecoverableMediaError,
  isYouTubeAuthRequiredError,
  shouldAutomaticallyRecoverMediaError,
  YOUTUBE_AUTH_REQUIRED_MESSAGE,
} from '../public/js/media-recovery.js';

test('only stale/unauthorized public media statuses trigger automatic re-resolution', () => {
  for (const status of [401, 403, 404, 410]) {
    assert.equal(isRecoverableMediaError({ status }), true);
  }
  for (const status of [400, 409, 422, 429, 500, undefined]) {
    assert.equal(isRecoverableMediaError({ status }), false);
  }
});

test('YouTube bot-check failures show actionable guidance and never enter automatic recovery', () => {
  const explicit = {
    status: 403,
    code: 'youtube_auth_required',
    message: 'Unable to resolve media',
  };
  assert.equal(isYouTubeAuthRequiredError(explicit), true);
  assert.equal(isRecoverableMediaError(explicit), false);
  assert.equal(
    shouldAutomaticallyRecoverMediaError(explicit, { nativeAdapterActive: true }),
    false,
  );
  assert.equal(mediaErrorMessage(explicit), YOUTUBE_AUTH_REQUIRED_MESSAGE);
  assert.match(mediaErrorMessage(explicit), /try another video/i);
  assert.match(mediaErrorMessage(explicit), /cookies or PO token/i);

  const nestedBotCheck = new MediaRecoveryExhaustedError(
    new Error("Sign in to confirm you're not a bot"),
  );
  assert.equal(isYouTubeAuthRequiredError(nestedBotCheck), true);
  assert.equal(
    shouldAutomaticallyRecoverMediaError(nestedBotCheck, { nativeAdapterActive: true }),
    false,
  );
  assert.equal(mediaErrorMessage(nestedBotCheck), YOUTUBE_AUTH_REQUIRED_MESSAGE);
});

test('native errors and stale relay statuses keep their existing recovery behavior', () => {
  assert.equal(
    shouldAutomaticallyRecoverMediaError({ status: 404 }, { nativeAdapterActive: false }),
    true,
  );
  assert.equal(
    shouldAutomaticallyRecoverMediaError(new Error('video error'), { nativeAdapterActive: true }),
    true,
  );
  assert.equal(
    shouldAutomaticallyRecoverMediaError({ status: 422 }, { nativeAdapterActive: false }),
    false,
  );
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('duplicate native media errors share one recovery flight', async () => {
  const pending = deferred();
  let operations = 0;
  const controller = new MediaRecoveryController();
  controller.activate('youtube:video');
  const operation = async () => {
    operations += 1;
    return pending.promise;
  };

  const first = controller.recover('youtube:video', operation);
  const duplicate = controller.recover('youtube:video', operation);
  assert.equal(operations, 1);

  pending.resolve('fresh-relay');
  assert.equal(await first, 'fresh-relay');
  assert.equal(await duplicate, 'fresh-relay');
  assert.equal(operations, 1);
  controller.destroy();
});

test('recovery retries once with bounded backoff then exposes the final failure', async () => {
  const delays = [];
  let operations = 0;
  const controller = new MediaRecoveryController({
    maxAttempts: 2,
    retryDelayMs: 250,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  await assert.rejects(
    controller.recover('youtube:video', async () => {
      operations += 1;
      throw new Error(`stale relay ${operations}`);
    }),
    (error) => {
      assert.ok(error instanceof MediaRecoveryExhaustedError);
      assert.match(error.message, /stale relay 2/);
      return true;
    },
  );
  assert.equal(operations, 2);
  assert.deepEqual(delays, [250]);

  await assert.rejects(
    controller.recover('youtube:video', async () => { operations += 1; }),
    MediaRecoveryExhaustedError,
  );
  assert.equal(operations, 2);
  controller.destroy();
});

test('a stable recovery window resets the attempt budget and media switches clear old state', async () => {
  const scheduled = [];
  const cancelled = [];
  let operations = 0;
  const controller = new MediaRecoveryController({
    schedule: (callback) => {
      const timer = { callback };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer) => { if (timer) cancelled.push(timer); },
  });

  await controller.recover('youtube:first', async () => { operations += 1; });
  assert.equal(operations, 1);
  scheduled[0].callback();
  await controller.recover('youtube:first', async () => { operations += 1; });
  assert.equal(operations, 2);

  controller.activate('youtube:second');
  assert.equal(controller.states.has('youtube:first'), false);
  assert.ok(cancelled.length >= 1);
  controller.destroy();
});
