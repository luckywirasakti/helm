const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { spawn } = require('child_process');

module.exports = (ws, url) => {
  // Terminal WebSocket
  if (url.pathname === '/ws/terminal') {
    const shell = process.env.SHELL || '/bin/bash';
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || '/root',
      env: { ...process.env, TERM: 'xterm-256color' }
    });
    proc.onData(data => { try { ws.send(JSON.stringify({ type: 'output', data })); } catch {} });
    proc.onExit(({ exitCode }) => { try { ws.send(JSON.stringify({ type: 'exit', exitCode })); ws.close(); } catch {} });
    ws.on('message', (msg) => {
      try {
        const { type, data, cols, rows } = JSON.parse(msg);
        if (type === 'input') proc.write(data);
        else if (type === 'resize') proc.resize(cols, rows);
      } catch {}
    });
    ws.on('close', () => proc.kill());
  }

  // Log streaming WebSocket
  if (url.pathname.startsWith('/ws/logs/')) {
    const service = url.pathname.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g, '');
    const proc = spawn('journalctl', ['-u', service, '-f', '--no-pager', '--output=short-precise'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', data => { try { ws.send(JSON.stringify({ type: 'log', data: data.toString() })); } catch {} });
    proc.stderr.on('data', data => { try { ws.send(JSON.stringify({ type: 'log', data: data.toString() })); } catch {} });
    ws.on('close', () => proc.kill());
  }
};

module.exports.createWSS = (server) => {
  return new WebSocketServer({ server });
};
