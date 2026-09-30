const { spawn } = require('node:child_process');

// Render's free Web Service can run the API and queue consumer in one
// container. They remain separate Node processes and communicate via
// BullMQ/Redis. Docker Compose overrides this command for local development.
const children = [
  spawn(process.execPath, ['server/worker.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' })
];
const alive = new Set(children);
let stopping = false;
let exitCode = 0;
let forceExitTimer;

function finishIfStopped() {
  if (stopping && alive.size === 0) {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }
}

function stop(code = 0) {
  if (!stopping) {
    stopping = true;
    exitCode = code;
    forceExitTimer = setTimeout(() => {
      for (const child of alive) child.kill('SIGKILL');
      process.exit(exitCode || 1);
    }, 25_000);
    forceExitTimer.unref();
    for (const child of alive) child.kill('SIGTERM');
  }
  finishIfStopped();
}

for (const child of children) {
  child.on('error', error => {
    console.error('Could not start API/worker process:', error);
    stop(1);
  });
  child.on('close', (code, signal) => {
    alive.delete(child);
    if (!stopping) {
      console.error(`API/worker process exited unexpectedly (code=${code}, signal=${signal}).`);
      stop(code || 1);
    } else {
      finishIfStopped();
    }
  });
}

process.once('SIGTERM', () => stop(0));
process.once('SIGINT', () => stop(0));
