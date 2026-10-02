export var JobsPrivateConnection;
let initialized = false;
export function initializePrivateConnection() {
  if (initialized) return;
  initialized = true;
  JobsPrivateConnection = null;
}
