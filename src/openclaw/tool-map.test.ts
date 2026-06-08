/**
 * Unit tests for remapToolInput's tool-aware shape transforms (BUGS 1 & 2).
 * Uses Node's built-in test runner (no new deps). Run after build:
 *   node --test dist/openclaw/tool-map.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remapToolInput } from './tool-map.js';

test('edit: Claude-native {file_path, old_string, new_string} wraps into OpenClaw {path, edits[]}', () => {
  const out = remapToolInput({ file_path: '/a.txt', old_string: 'x', new_string: 'y' }, 'edit');
  assert.deepEqual(out, { path: '/a.txt', edits: [{ old_string: 'x', new_string: 'y' }] });
});

test('edit: replace_all is carried into the edit element', () => {
  const out = remapToolInput({ file_path: '/a.txt', old_string: 'x', new_string: 'y', replace_all: true }, 'edit');
  assert.deepEqual(out, { path: '/a.txt', edits: [{ old_string: 'x', new_string: 'y', replace_all: true }] });
});

test('edit: already-correct {path, edits[]} passes through unchanged (idempotent)', () => {
  const input = { path: '/a.txt', edits: [{ old_string: 'x', new_string: 'y' }] };
  const out = remapToolInput(structuredClone(input), 'edit');
  assert.deepEqual(out, input);
});

test('spawn: prompt renamed to task (sessions_spawn)', () => {
  const out = remapToolInput({ description: 'd', prompt: 'do the thing', subagent_type: 'raven-scout' }, 'sessions_spawn');
  assert.deepEqual(out, { description: 'd', task: 'do the thing', subagent_type: 'raven-scout' });
});

test('spawn: matches the spawn-tool aliases (spawn, subagents, run_agent, delegate)', () => {
  for (const name of ['spawn', 'subagents', 'run_agent', 'delegate']) {
    const out = remapToolInput({ prompt: 'p' }, name) as Record<string, unknown>;
    assert.equal(out.task, 'p', `task set for ${name}`);
    assert.equal('prompt' in out, false, `prompt removed for ${name}`);
  }
});

test('spawn: existing task is not clobbered (idempotent)', () => {
  const input = { description: 'd', task: 'real', subagent_type: 't' };
  const out = remapToolInput(structuredClone(input), 'sessions_spawn');
  assert.deepEqual(out, input);
});

test('unrelated tool: passes through (only the file_path->path rename applies)', () => {
  const out = remapToolInput({ command: 'ls', timeout: 5 }, 'exec');
  assert.deepEqual(out, { command: 'ls', timeout: 5 });
});

test('no tool name: rename-only behavior preserved (backward compatible)', () => {
  const out = remapToolInput({ file_path: '/a.txt', old_string: 'x', new_string: 'y' });
  assert.deepEqual(out, { path: '/a.txt', old_string: 'x', new_string: 'y' }); // no shape transform without a tool name
});

test('non-object input returns unchanged', () => {
  assert.equal(remapToolInput(null, 'edit'), null);
  assert.equal(remapToolInput('str', 'edit'), 'str');
});
