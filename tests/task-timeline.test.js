'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskTimeline } = require('../server/task-timeline');

const hour = 3600000;
const start = Date.parse('2026-11-27T09:00:00Z');
const event = (action, hours, details = {}) => ({
    action, created_at: new Date(start + hours * hour).toISOString(), details
});
const task = (result, owner = '42') => ({ result, owner_id: owner, created_at: new Date(start) });

test('sums the four stages and stops at the result save time', () => {
    const events = [
        event('task_create', 0, { owner: null }),
        event('task_claim', 1),
        event('comment_done', 3),
        event('comment_done', 4),
        event('task_result', 5, { to: 'postponed' }),
        event('task_result', 8, { to: 'success', date: '2026-11-25' })
    ];
    assert.deepEqual(taskTimeline(task('success'), events, start + 24 * hour), {
        durations: { waiting: hour, working: 2 * hour, done: 2 * hour, result: 3 * hour },
        current: null
    });
});

test('counts assignment, revocation and reassignment without resetting prior work', () => {
    const events = [
        event('task_create', 0, { owner: '11' }),
        event('task_revoke', 2),
        event('task_assign', 4, { to: '42' }),
        event('task_assign', 5, { to: '99' })
    ];
    assert.deepEqual(taskTimeline(task('none', '99'), events, start + 6 * hour), {
        durations: { waiting: 2 * hour, working: 4 * hour, done: null, result: null },
        current: 'working'
    });
});

test('does not include time the task was closed before reopening', () => {
    const events = [
        event('task_create', 0, { owner: '42' }),
        event('task_result', 1, { to: 'failed' }),
        event('task_result', 5, { to: 'none' }),
        event('task_result', 6, { to: 'success' })
    ];
    assert.deepEqual(taskTimeline(task('success'), events, start + 30 * hour), {
        durations: { waiting: 0, working: 2 * hour, done: null, result: 0 },
        current: null
    });
});

test('does not invent a timeline if assignment or closure was not recorded', () => {
    const events = [event('task_create', 0, { owner: null })];
    assert.equal(taskTimeline(task('none'), events, start + hour), null);
    assert.equal(taskTimeline(task('failed', null), events, start + hour), null);
    assert.equal(taskTimeline(task('none', null), [], start + hour), null);
});
