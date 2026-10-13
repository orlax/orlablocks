// Only a spare server with a separate DATA_DIR. Scene operations go through MCP/WS.
// node scripts/performance-fixture.mjs 5171 [small|mixed]
import { connect } from './check-client.mjs';
const port = Number(process.argv[2] ?? 5171);
if (!Number.isInteger(port) || port === 5170) throw new Error('Use a scratch server, never 5170');
const kind = process.argv[3] ?? 'mixed';
if (!['small', 'mixed'].includes(kind)) throw new Error('Expected small or mixed');
const session = await connect(port, { project: `Performance 17.1 ${kind} ${Date.now()}` });
try {
  await session.call('get_scene');
  await session.call('get_guide', {topic:'design'});
  const shapes = Array.from({length: kind === 'small' ? 8 : 400}, (_, i) => ({
    type: i % 5 === 0 ? 'cylinder' : 'box', name: `Fixture ${i}`, kind: i % 7 === 0 ? 'room' : 'volume',
    x: (i % 20 - 10) * 5, z: (Math.floor(i / 20) - 10) * 5,
    ...(i % 5 === 0 ? {width:3, depth:3, sides:16} : {width:3, depth:3}), height: 2 + i % 4,
  }));
  await session.call('draw_shapes', {shapes});
  console.log(JSON.stringify({project: session.project, fixture:kind, shapes:shapes.length}));
} finally { await session.close(); }
