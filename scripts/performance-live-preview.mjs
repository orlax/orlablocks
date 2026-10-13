// Serve a production frontend against an existing editor, forwarding only non-edit messages.
// npm run build:web; node scripts/performance-live-preview.mjs [preview-port=5173] [editor-port=5170]
// No scene files, fixture creation or server restart; use only for read-only navigation/capture profiling.
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
const previewPort=Number(process.argv[2] ?? 5173), editorPort=Number(process.argv[3] ?? 5170);
if(previewPort===editorPort) throw new Error('Preview must use a separate port');
const app=express();
app.use(express.static(fileURLToPath(new URL('../dist/web',import.meta.url))));
const server=app.listen(previewPort,'127.0.0.1');
new WebSocketServer({server,path:'/ws'}).on('connection',browser=>{
  const upstream=new WebSocket(`ws://127.0.0.1:${editorPort}/ws`), queue=[];
  browser.on('message',raw=>{
    const message=JSON.parse(String(raw));
    if(!['tab','set_view','rendered'].includes(message.type)) return;
    if(upstream.readyState===WebSocket.OPEN) upstream.send(String(raw)); else queue.push(String(raw));
  });
  upstream.on('open',()=>queue.splice(0).forEach(message=>upstream.send(message)));
  upstream.on('message',raw=>browser.readyState===WebSocket.OPEN&&browser.send(String(raw)));
  browser.on('close',()=>upstream.close());
  upstream.on('close',()=>browser.close());
  upstream.on('error',()=>browser.close());
});
console.log(`Read-only production frontend: http://127.0.0.1:${previewPort} (editor ${editorPort})`);
