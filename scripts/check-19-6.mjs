import assert from 'node:assert/strict';
import { connect } from './check-client.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const port = Number(process.argv[2] ?? 5176);
const session = await connect(port, { project: `19.6 cut tags ${Date.now()}` });
const { call, human, opened } = session;
const protocol = new Client({ name: 'cut-tags-schema', version: '1' });
try {
  await protocol.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  assert.equal(protocol.getServerVersion().version, '0.0.49');
  const schemas = JSON.stringify((await protocol.listTools()).tools.find((t) => t.name === 'draw_shapes').inputSchema);
  assert(schemas.includes('cutTags') && schemas.includes('cutTagParts'));
  await call('get_guide', { topic: 'holes' });
  const made = await call('draw_shapes', { shapes: [
    { type: 'group', ref: 'building', name: 'Building' },
    { type: 'group', ref: 'mezz', name: 'Mezzanine', parent: '$building' },
    { type: 'box', ref: 'wall', name: 'Lobby wall', x: 0, z: 0, width: 8, depth: 0.5, height: 4, cutTags: ['lobby'] },
    { type: 'box', name: 'Untouched wall', x: 0, z: 2, width: 8, depth: 0.5, height: 4, cutTags: ['gallery'] },
    { type: 'box', ref: 'hole', name: 'Roof doorway', parent: '$mezz', kind: 'hole', x: 0, z: 0, width: 2, depth: 6, height: 3, cutTags: ['lobby'] },
  ] });
  const r = made.refs;
  assert.deepEqual((await call('get_scene', { ids: [r.hole], full: true })).nodes[0].cutTags, ['lobby']);
  await call('update_nodes', { changes: [{ id: r.hole, parent: null }] });
  assert.deepEqual((await call('get_scene', { ids: [r.hole], full: true })).nodes[0].cutTags, ['lobby']);
  await call('update_nodes', { changes: [{ id: r.hole, cutTags: [] }] });
  await human.request({ type: 'undo' }, (m) => m.type === 'scene');
  assert.deepEqual((await call('get_scene', { ids: [r.hole], full: true })).nodes[0].cutTags, ['lobby']);
  const before = (await call('get_scene', { full: true })).nodes;
  const bad = await call('update_nodes', { changes: [{ id: r.wall, name: 'bad' }, { id: r.building, cutTags: ['x'] }] }, { allowError: true });
  assert(bad.error); assert.deepEqual((await call('get_scene', { full: true })).nodes, before);
  const invalid = await call('draw_shapes', { shapes: [{ x: 0, z: 0, width: 1, depth: 1, cutTags: ['bad:tag'] }] }, { allowError: true });
  assert(invalid.error);
  await call('define_entity', { name: 'Internal door', shapes: [
    { x: 0, z: 0, width: 3, depth: 0.4, height: 3.5, cutTags: ['frame'] },
    { kind: 'hole', x: 0, z: 0, width: 2, depth: 1, height: 3, cutTags: ['frame'] },
  ] });
  await call('draw_shapes', { shapes: [{ type: 'instance', entity: 'internal-door', name: 'Door with external cuts', x: 4, z: 0, cutTags: ['lobby'] }] });
  const saved = (await call('get_scene', { full: true })).nodes;
  await human.request({ type: 'open_scene', project: opened.project.id, scene: opened.scene.id }, (m) => m.type === 'opened' && m.open?.scene.id === opened.scene.id);
  assert.deepEqual((await call('get_scene', { full: true })).nodes, saved);
  human.send({ type: 'set_selection', ids: [r.hole] });
  console.log(JSON.stringify({ ok: true, project: opened.project.id, scene: opened.scene.id, refs: r }));
} finally { await protocol.close(); await session.close(); }
