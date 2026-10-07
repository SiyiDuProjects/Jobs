import { JobsSelectState } from "../../src/custom/select-state.js";

// Observe native choices before the person can interact with the form.
JobsSelectState.observe(document, { fromStart: true });
