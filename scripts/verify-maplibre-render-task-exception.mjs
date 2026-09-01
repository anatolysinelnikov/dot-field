// Focused regression model for MapLibre GL JS 5.24.0's render-task failure
// lifecycle. The application loads MapLibre from a CDN, so this keeps the
// dependency contract test dependency-free while mirroring the relevant
// TaskQueue and triggerRepaint behavior.

class TaskQueue {
  constructor() {
    this.queue = [];
    this.currentlyRunning = false;
  }

  add(callback) {
    this.queue.push(callback);
  }

  run(timestamp = 0) {
    if (this.currentlyRunning) throw new Error('Attempting to run(), but is already running.');
    const queue = this.currentlyRunning = this.queue;
    this.queue = [];
    for (const callback of queue) callback(timestamp);
    this.currentlyRunning = false;
  }
}

class MapRenderScheduler {
  constructor() {
    this.style = true;
    this.frameRequest = null;
    this.renderTaskQueue = new TaskQueue();
    this.renderCount = 0;
    this.repaintRequestCount = 0;
  }

  triggerRepaint() {
    this.repaintRequestCount++;
    if (!this.style || this.frameRequest) return;
    this.frameRequest = {};
  }

  runScheduledFrame(timestamp = 0) {
    if (!this.frameRequest) throw new Error('No scheduled frame.');
    this.frameRequest = null;
    this.renderTaskQueue.run(timestamp);
    this.renderCount++;
  }
}

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else {
    failures++;
    console.error(`FAIL ${message}`);
  }
}

const scheduler = new MapRenderScheduler();
const applicationError = new Error('application move callback failed');
scheduler.renderTaskQueue.add(() => { throw applicationError; });
scheduler.triggerRepaint();

try {
  scheduler.runScheduledFrame();
} catch (error) {
  check(error === applicationError, 'the application callback exception escapes the render task');
}

check(scheduler.frameRequest === null, 'triggerRepaint clears the scheduled-frame gate before render');
check(scheduler.renderCount === 0, 'a failed render task prevents the map render from completing');

scheduler.triggerRepaint();
check(scheduler.repaintRequestCount === 2, 'a later repaint request is still accepted');
try {
  scheduler.runScheduledFrame();
} catch (error) {
  check(error.message === 'Attempting to run(), but is already running.', 'the failed TaskQueue remains poisoned for later frames');
}

check(scheduler.renderCount === 0, 'later repaint requests do not reach map painting after TaskQueue poisoning');

if (failures) process.exitCode = 1;
else console.log('MapLibre render-task exception lifecycle verification passed.');
