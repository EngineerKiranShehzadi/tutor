// Toggleable proxy in front of the real embedding server (default :5001), used by the e2e run to
// simulate a SLOW embedding service and an OUTAGE without touching the real server.
//   node e2e/embed-proxy.js [listenPort=5101] [target=http://localhost:5001]
//   curl localhost:5101/__delay?ms=3000     -> every /embed call now takes +3000ms
const http = require('http');
const listen = parseInt(process.argv[2] || '5101', 10);
const target = new URL(process.argv[3] || 'http://localhost:5001');
let delayMs = 0;
http.createServer((req, res) => {
  if (req.url.startsWith('/__delay')) {
    delayMs = parseInt(new URL(req.url, 'http://x').searchParams.get('ms') || '0', 10);
    res.end(JSON.stringify({ delayMs }));
    return;
  }
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => setTimeout(() => {
    const p = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, r => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    p.on('error', e => { res.writeHead(502); res.end(String(e)); });
    p.end(Buffer.concat(chunks));
  }, delayMs));
}).listen(listen, () => console.log(`embed-proxy :${listen} -> ${target.href}`));
