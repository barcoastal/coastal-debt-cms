"""Isolated Join3 preview: never opens the CMS database or sends leads externally."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, unquote
import json, mimetypes
ROOT = Path(__file__).resolve().parents[2]
PREVIEW = Path(__file__).parent / 'preview' / 'index.html'
class Handler(BaseHTTPRequestHandler):
    def send(self, body, mime='application/json', status=200):
        if not isinstance(body, bytes): body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == '/api/visitors/ip': return self.send({'ip':'127.0.0.1'})
        if path in ('/', '/lp/join3/'):
            return self.send(PREVIEW.read_bytes(), 'text/html')
        if path.startswith('/lp/assets/'):
            base = ROOT/'public/assets'; file = (base/path[len('/lp/assets/'):]).resolve()
            if file.is_relative_to(base) and file.is_file():
                return self.send(file.read_bytes(), mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        self.send({'error':'Not found'}, status=404)
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
        if self.path == '/api/leads':
            (PREVIEW.parent/'last-test-lead.json').write_text(json.dumps(data, indent=2))
            print('Local test lead received; no external submission.', flush=True)
        self.send({'success':True})
    def log_message(self,*args): pass
print('Join3 isolated preview: http://localhost:3097/lp/join3/', flush=True)
ThreadingHTTPServer(('127.0.0.1',3097), Handler).serve_forever()
