// Runs the Streamora server inside an Electron utility process.

// Windows has no SIGTERM, so the app asks for a clean shutdown with a message.
// Emitting the signal runs the server's own shutdown handler.
process.parentPort.on('message', (event) => {
  if (event.data === 'shutdown') process.emit('SIGTERM');
});

await import('./backend/dist/index.js');
