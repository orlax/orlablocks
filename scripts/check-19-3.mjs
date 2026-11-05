// Browser fixture only; run against a spare server with a scratch DATA_DIR.
import { connect } from './check-client.mjs';
const session = await connect(Number(process.argv[2] ?? 5171), { project: `19.3 snapping/context ${Date.now()}` });
try {
  await session.call('get_scene');
  await session.call('get_guide', { topic: 'design' });
  const result = await session.call('draw_shapes', { shapes: [
    { type: 'group', ref: 'group', name: 'Context assembly' },
    { type: 'box', parent: '$group', name: 'Snap block', x: 0, z: 0, width: 4, depth: 4, height: 1 },
    { type: 'box', name: 'Other block', x: 8, z: 0, width: 3, depth: 3, height: 2 },
    { type: 'box', ref: 'locked', name: 'Locked block', x: -8, z: 0, width: 3, depth: 3, height: 2 },
    { type: 'array', name: 'Circle handles', entities: [{ entity: 'human' }], layout: { type: 'circle', x: 0, y: 0, z: 9, radius: 3, count: 8 } },
    { type: 'line', name: 'Point edits', points: [{ x: -6, z: -7, y: 0 }, { x: 0, z: -7, y: 1 }, { x: 6, z: -7, y: 2 }] },
  ] });
  await session.human.request({ type: 'update_nodes', changes: [{ id: result.refs.locked, locked: true }] }, m => m.type === 'scene');
  console.log(JSON.stringify(result.refs));
} finally { await session.close(); }
