import {
  compactFailureSlice,
  compactPeriodicSnapshot,
  runDiagnosticCallback,
  serializeCallbackException
} from '../src/runtime-diagnostics.js';

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else {
    failures++;
    console.error(`FAIL ${message}`);
  }
}

const error = new TypeError('camera callback failed');
error.stack = `TypeError: camera callback failed\n${'at map-move-callback (app.js:2730)\n'.repeat(200)}`;
const errorDetails = serializeCallbackException('map-move-callback', 17, error, 1234);
check(errorDetails.kind === 'error-like', 'Error values are classified as error-like');
check(errorDetails.callbackName === 'map-move-callback' && errorDetails.callbackId === 17,
  'Error details retain callback name and ID');
check(errorDetails.name === 'TypeError' && errorDetails.message === 'camera callback failed',
  'Error name and message are captured');
check(errorDetails.stack?.startsWith('TypeError: camera callback failed'), 'Error stack is captured');
check(errorDetails.timestamp === 1234 && errorDetails.stack.length <= 4000, 'Error detail timestamp and stack bound are enforced');

const thrownValue = { toString: () => 'x'.repeat(800) };
const thrownDetails = serializeCallbackException('map-move-callback', 18, thrownValue, 1235);
check(thrownDetails.kind === 'thrown-value' && thrownDetails.typeof === 'object',
  'Non-Error values retain their typeof');
check(thrownDetails.value.length <= 500 && thrownDetails.value.startsWith('xxx'),
  'Non-Error values use a bounded safe string');

let exitRecord = null;
const diagnostics = {
  recordCallbackEnter(name) {
    check(name === 'map-move-callback', 'production callback wrapper enters the named callback');
    return 19;
  },
  recordCallbackExit(id, completed, value) {
    exitRecord = { id, completed, value };
  }
};
try {
  runDiagnosticCallback('map-move-callback', () => { throw error; }, diagnostics);
} catch (caught) {
  check(caught === error, 'the original thrown Error identity still propagates');
}
check(exitRecord?.id === 19 && exitRecord.completed === false && exitRecord.value === error,
  'callback exit receives the original thrown value without swallowing it');

const failureData = {
  samples: [{ sequence: 1, elapsedMs: 200, activity: { callbackExceptionCount: 1 } }],
  events: [{ sessionId: 'test', sequence: 2, elapsedMs: 200, type: 'callback-exception', details: errorDetails }],
  weatherResources: []
};
const activeFailure = compactFailureSlice(failureData);
const recoveredFailure = compactFailureSlice(failureData);
check(activeFailure.latestCallbackException?.message === 'camera callback failed'
  && activeFailure.events[0].details.stack === errorDetails.stack,
  'compact active failure slice contains callback exception detail');
check(recoveredFailure.latestCallbackException?.callbackId === 17
  && recoveredFailure.events[0].details.name === 'TypeError',
  'recovered failure slice retains callback exception detail');

const normalSample = JSON.stringify({
  ...compactPeriodicSnapshot({}),
  activity: { callbackExceptionCount: 1, lastCallbackName: 'map-move-callback' }
});
check(!normalSample.includes('camera callback failed') && !normalSample.includes('TypeError:'),
  'normal periodic samples remain free of exception message and stack');

if (failures) process.exitCode = 1;
else console.log('Runtime diagnostics callback-exception verification passed.');
