#!/usr/bin/env python3
"""Local static server with HTTP Range support (needed by .4dgs streaming). Usage: python3 tools/serve.py [port]"""
import http.server, os, re, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
        if not m:
            self.send_error(416); return None
        a, b = m.groups()
        if a == "":
            start, end = max(0, size - int(b)), size - 1
        else:
            start, end = int(a), min(int(b) if b else size - 1, size - 1)
        f = open(path, "rb"); f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._reste = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        n = getattr(self, "_reste", None)
        if n is None:
            return super().copyfile(source, outputfile)
        while n > 0:
            b = source.read(min(n, 1 << 20))
            if not b: break
            outputfile.write(b); n -= len(b)

    def do_POST(self):
        # test pages post their measurements here: test/sortie/<nom>.json
        if self.path.startswith("/resultat"):
            import json, urllib.parse
            nom = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("nom", ["perf"])[0]
            nom = "".join(c for c in nom if c.isalnum() or c in "_-") or "perf"
            corps = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            os.makedirs("test/sortie", exist_ok=True)
            open(f"test/sortie/{nom}.json", "wb").write(corps)
            self.send_response(204); self.end_headers(); return
        self.send_error(404)

    def do_OPTIONS(self):                       # CORS preflight (the Range header is not a "simple" header)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Max-Age", "3600")
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # as a CDN: pages of other origins may load the player, its workers and the videos (tests of a third-party app)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        super().end_headers()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
