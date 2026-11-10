import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SLACK_CHANNEL,
  DEFAULT_STATE,
  isValidSlackChannel,
  resolveSlackChannel,
} from "../src/lib/store";
import type { VelnorState } from "../src/lib/store";

// The suite must not depend on how the machine running it is configured: an
// ambient SLACK_CHANNEL would otherwise leak into the default-resolution tests.
delete process.env.SLACK_CHANNEL;

function stateWith(channel?: string): VelnorState {
  return { ...structuredClone(DEFAULT_STATE), config: { ...DEFAULT_STATE.config, slackChannel: channel } };
}

test("the default Slack channel is the agent's own channel", () => {
  assert.equal(DEFAULT_SLACK_CHANNEL, "#velnor-agent");
  assert.equal(resolveSlackChannel(stateWith()), "#velnor-agent");
});

test("a configured channel overrides the default", () => {
  assert.equal(resolveSlackChannel(stateWith("#ops-alerts")), "#ops-alerts");
  assert.equal(resolveSlackChannel(stateWith("C0123456789")), "C0123456789");
});

test("an empty or whitespace-only override falls back instead of posting nowhere", () => {
  assert.equal(resolveSlackChannel(stateWith("")), "#velnor-agent");
  assert.equal(resolveSlackChannel(stateWith("   ")), "#velnor-agent");
});

test("the deployment can pin the channel by environment, and state still wins", () => {
  const previous = process.env.SLACK_CHANNEL;
  try {
    process.env.SLACK_CHANNEL = "C0CFWLMSP9V";
    assert.equal(resolveSlackChannel(stateWith()), "C0CFWLMSP9V");
    assert.equal(resolveSlackChannel(stateWith("#ops-alerts")), "#ops-alerts");

    process.env.SLACK_CHANNEL = "  ";
    assert.equal(resolveSlackChannel(stateWith()), "#velnor-agent");
  } finally {
    if (previous === undefined) delete process.env.SLACK_CHANNEL;
    else process.env.SLACK_CHANNEL = previous;
  }
});

test("channel validation accepts names and ids, and rejects what Slack would reject", () => {
  for (const good of ["#velnor-agent", "#ops_alerts", "#eng-team.v2", "C0123456789", "G0123ABCDEF"]) {
    assert.equal(isValidSlackChannel(good), true, `${good} should be accepted`);
  }
  for (const bad of ["velnor-agent", "#", "#has space", "@user", "C12", "", "#" + "x".repeat(90)]) {
    assert.equal(isValidSlackChannel(bad), false, `${bad} should be rejected`);
  }
});
