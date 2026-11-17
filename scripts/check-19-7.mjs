import assert from 'node:assert/strict';
import { connect } from './check-client.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const port = Number(process.argv[2] ?? 5177);
const session = await connect(port, { project: `19.7 wall mounts ${Date.now()}` });
const { call, human, opened } = session;
const protocol = new Client({ name: 'mount-schema', version: '1' });
try {
  await protocol.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  assert.equal(protocol.getServerVersion().version, '0.0.50');
  const tools = (await protocol.listTools()).tools;
  for (const name of ['draw_shapes', 'update_nodes']) {
    const schema = JSON.stringify(tools.find((t) => t.name === name).inputSchema);
    assert(schema.includes('wallAttachment') && schema.includes('polar'));
  }
  await call('define_entity', { name: 'Wall frame', shapes: [{ x: 0, z: 0, width: 0.1, depth: 1.5, height: 1, color: 'yellow' }] });
  const attachment = (angle) => ({ id: '$tower', side: 'inner', angle, elevation: 3, offset: 0.02, facingOffset: 0 });
  const made = await call('draw_shapes', { shapes: [
    { type: 'cylinder', ref: 'tower', name: 'Rotunda support', kind: 'room', floor: false, x: 0, z: 0, width: 14, depth: 14, height: 7, wall: 0.4 },
    ...Array.from({ length: 9 }, (_, i) => ({ type: 'instance', ref: `art${i}`, name: `Frame ${i + 1}`, entity: 'wall-frame', wallAttachment: attachment(i * 40) })),
    { type: 'instance', ref: 'polar', name: 'One-shot polar', entity: 'wall-frame', polar: { around: '$tower', radius: 4, angle: 45, elevation: 1, facing: 'in', rotationOffset: 90 } },
  ] });
  const r = made.refs;
  const full = async () => (await call('get_scene', { full: true })).nodes;
  const before = await full();
  for (const args of [
    { shapes: [{ type: 'instance', entity: 'wall-frame', x: 1, polar: { around: r.tower, radius: 3, angle: 0 } }] },
    { shapes: [{ type: 'instance', entity: 'wall-frame', wallAttachment: { ...attachment(0), id: '$future' } }] },
  ]) assert((await call('draw_shapes', args, { allowError: true })).error);
  assert.deepEqual(await full(), before);
  await call('update_nodes', { changes: [{ id: r.tower, x: 2, z: 1, rotation: 90, width: 16, depth: 16, wall: 0.6 }] });
  const after = await full();
  assert.deepEqual(after.find((n) => n.id === r.polar), before.find((n) => n.id === r.polar));
  assert.equal(after.find((n) => n.id === r.art0).rotation, 270);
  assert.equal(after.find((n) => n.id === r.art0).z, -6.38);
  const lint = await call('check_scene', { checks: ['attachments', 'floating'], floats: [r.polar] });
  assert.deepEqual(lint.findings, []);
  await human.request({ type: 'undo' }, (m) => m.type === 'scene');
  assert.deepEqual(await full(), before);
  await human.request({ type: 'redo' }, (m) => m.type === 'scene');
  assert.deepEqual(await full(), after);
  await call('remove_nodes', { ids: [r.tower] });
  const broken = await full();
  assert.deepEqual(broken.find((n) => n.id === r.art0), after.find((n) => n.id === r.art0));
  assert(JSON.stringify(await call('check_scene', { checks: ['attachments'] })).includes('missing'));
  await human.request({ type: 'undo' }, (m) => m.type === 'scene');
  await human.request({ type: 'open_scene', project: opened.project.id, scene: opened.scene.id }, (m) => m.type === 'opened' && m.open?.scene.id === opened.scene.id);
  assert.deepEqual(await full(), after);
  const [oneShot] = (await call('draw_shapes', { shapes: [{ type: 'box', width: 1, depth: 1, polar: { around: r.tower, radius: 3, angle: 0, elevation: 1, facing: 'in' } }], verbose: true })).created;
  assert.equal(oneShot.x, 2); assert.equal(oneShot.z, -2); assert.equal(oneShot.rotation, 270);
  await call('update_nodes', { changes: [{ id: oneShot.id, polar: { around: r.tower, radius: 2, angle: 90 } }, { id: r.tower, x: 4 }] });
  const updatedBox = (await full()).find((n) => n.id === oneShot.id);
  assert.equal(updatedBox.x, 2); assert.equal(updatedBox.z, 1); assert.equal(updatedBox.rotation, 180);
  human.send({ type: 'set_selection', ids: [r.art0] });
  console.log(JSON.stringify({ ok: true, project: opened.project.id, scene: opened.scene.id, refs: r, batchBytes: JSON.stringify(made).length, frameCount: 9 }));
} finally { await protocol.close(); await session.close(); }
