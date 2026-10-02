// Scripted "model": calls the hotel-chain tools in order without writing any text
// (the silent tool-caller the goal line used to freeze on), then answers.
const http = require('http');
const fs = require('fs');
const LOG = process.argv[2];
const PLAN = [
  ['search_location', { query: 'Paris', checkin_date: '2026-10-16', nights: 3, adults: 2 }],
  ['get_hotel_search_results', {}],
  ['view_hotel', { hotel_name_or_id: 'champs' }],
  ['lookup_amenity', { hotel_id: 'champs', amenity: 'spa' }],
  ['start_booking', {}],
  ['complete_booking', { firstName: 'Carlos', lastName: 'Mendoza Ramos', email: 'carlos.mendoza.demo@example.com' }],
];
const record = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'fake:latest', model: 'fake:latest', size: 1, capabilities: ['completion', 'tools'] }] }));
    }
    if (req.url === '/api/chat') {
      const data = JSON.parse(body || '{}');
      if (!data.stream && data.stream !== undefined || !data.tools) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: { role: 'assistant', content: '["Search hotels in Paris"]' }, done: true }));
      }
      const msgs = data.messages || [];
      let lastUser = -1;
      msgs.forEach((m, i) => { if (m.role === 'user' && !/^Continue with the next step/.test(m.content)) lastUser = i; });
      const done = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
      record({ round: done, tools: (data.tools || []).map((t) => t.function.name), system: (msgs[0] && msgs[0].content) || '', toolResults: msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').map((m) => [m.tool_name, String(m.content).slice(0, 200)]) });
      const step = PLAN[done];
      const message = step
        ? { role: 'assistant', content: '', tool_calls: [{ function: { name: step[0], arguments: step[1] } }] }
        : { role: 'assistant', content: 'Booked Le Champs-Élysées, 16–19 Oct 2026, 2 adults. Total $1386. The site issues no confirmation code, and has no Suite, phone field or terms checkbox.' };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message, done: false }) + '\n');
      return res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    }
    res.writeHead(404); res.end();
  });
}).listen(11434, '127.0.0.1', () => console.log('fake ollama up'));
