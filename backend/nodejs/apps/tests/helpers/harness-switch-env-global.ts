/**
 * Loaded via .mocharc.yaml `require` BEFORE any test file.
 *
 * The agent harness is off unless an install turns it on (ADR-OPS-06, AGENT_HARNESS_WORKER_ENABLED). Most of this
 * suite exercises the harness, so the process runs as an install that turned it on. A test of the switch itself or
 * of the default passes its own environment (every reader takes one) or sets the variable for its own duration.
 */
if (process.env.AGENT_HARNESS_WORKER_ENABLED == null) {
  process.env.AGENT_HARNESS_WORKER_ENABLED = 'true';
}

/*
 * The security profile (ADR-OPS-07, PIPESHUB_HARDENED): unset reads compatibility, the behaviour of a release without
 * the security programme's hardened defaults. Most of this suite was written for those defaults, so the process runs
 * as a hardened install; a test of the compatibility profile passes its own environment or deletes the variable for
 * its own duration.
 */
if (process.env.PIPESHUB_HARDENED == null) {
  process.env.PIPESHUB_HARDENED = 'true';
}
