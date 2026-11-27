'use strict';

const { finished } = require('./rules');

function taskTimeline(task, events, now) {
    const start = task.created_at instanceof Date ? task.created_at.getTime() : Date.parse(task.created_at);
    if (!Number.isFinite(start) || events[0]?.action !== 'task_create' ||
        !Object.hasOwn(events[0].details || {}, 'owner')) return null;

    let assigned = events[0].details.owner != null;
    let workStage = 'working';
    let result = 'none';
    let stage = assigned ? workStage : 'waiting';
    let cursor = start;
    const durations = { waiting: assigned ? 0 : null, working: null, done: null, result: null };

    for (const { action, created_at, details } of events.slice(1)) {
        const timestamp = Date.parse(created_at);
        if (!Number.isFinite(timestamp)) return null;
        if (action === 'task_claim' || action === 'task_assign') assigned = true;
        if (action === 'task_revoke') assigned = false;
        if (action === 'comment_done' && assigned && !finished({ result })) workStage = 'done';
        if (action === 'task_result') result = details.to;

        const nextStage = finished({ result }) ? null :
            !assigned ? 'waiting' : result === 'postponed' ? 'result' : workStage;
        if (nextStage === stage) continue;
        const end = Math.max(cursor, timestamp);
        if (stage) durations[stage] = (durations[stage] ?? 0) + end - cursor;
        if (stage && !nextStage && durations.result === null) durations.result = 0;
        stage = nextStage;
        cursor = end;
    }

    // A task without a complete audit trail cannot give reliable times.
    if (assigned !== (task.owner_id != null) || result !== task.result) return null;
    if (stage) durations[stage] = (durations[stage] ?? 0) + Math.max(0, now - cursor);
    return { durations, current: stage };
}

module.exports = { taskTimeline };
