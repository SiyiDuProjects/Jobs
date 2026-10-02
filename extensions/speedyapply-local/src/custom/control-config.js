export var JobsControlConfig;
let initialized = false;
export function initializeControlConfig() {
  if (initialized) return;
  initialized = true;
  JobsControlConfig = Object.freeze({ enabled: true, observe: true });
}
