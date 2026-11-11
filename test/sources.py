#!/usr/bin/env python3
"""Every kind of source in headless Chromium: .4dgs (URL and local File), ITHACA manifests, lone .ftgsz and .ply
   sequences (HD, Low Quality), share link.  python3 test/sources.py   (test files in test/data, not in the repo)
   The share link case adds the CORS headers of the ITHACA site and storage in the browser (CORS=1 to keep them off)."""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ICI = os.path.dirname(os.path.abspath(__file__)); RACINE = os.path.dirname(ICI)
CAS = [("4dgs", "data/coucou.4dgs", ""), ("4dgs File", "data/coucou.4dgs", "&blob=1"),
       ("manifest HD", "data/cerfav1M/manifest.json", ""), ("manifest LQ", "data/coucou_lq/manifest.json", ""),
       ("ftgsz HD", "data/cerfav1M/seq001.ftgsz", ""), ("ply HD", "data/cerfav1M/seq001.ply", ""),
       ("ftgsz LQ", "data/coucou_lq/seg1.ftgsz", "&frames=65"), ("ply LQ", "data/coucou_lq/seg1.ply", "&frames=65"),
       ("ply LQ File", "data/coucou_lq/seg1.ply", "&frames=65&blob=1"), ("LQ sans frames", "data/coucou_lq/seg1.ftgsz", ""),
       ("lien de partage", "https://www.ithaca.eu/?ithaca_partage=FTTN757OptLt3aresYXUV9B-", "")]
seulement = sys.argv[1:]
def cors(route):
    r = route.fetch()
    h = {**r.headers, "access-control-allow-origin": "*", "access-control-expose-headers": "Content-Range, Content-Length, ETag"}
    route.fulfill(response=r, headers=h)
serveur = subprocess.Popen([sys.executable, os.path.join(RACINE, "tools/serve.py"), "8771"], cwd=RACINE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
os.makedirs(os.path.join(ICI, "sortie"), exist_ok=True)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("CHROME") or None, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        for nom, src, extra in CAS:
            if seulement and nom not in seulement: continue
            ctx = b.new_context(viewport={"width": 640, "height": 480}); page = ctx.new_page(); err = []
            if os.environ.get("CORS") != "1":
                ctx.route("https://www.ithaca.eu/wp-admin/admin-ajax.php*", cors); ctx.route("https://s3.*.cloud.ovh.net/**", cors)
            page.on("pageerror", lambda e: err.append(str(e)))
            page.on("console", lambda m: err.append(m.text) if m.type == "error" else None)
            t0 = time.time()
            page.goto(f"http://127.0.0.1:8771/test/index.html?src={src}{extra}&cam=" + os.environ.get("CAM", "0,1.1,3.2"))
            page.wait_for_function("window.__etat && window.__etat !== 'load'", timeout=180000)
            page.wait_for_timeout(1500)
            etat = page.evaluate("window.__etat")
            info = page.evaluate("[window.__video.sequences.length, window.__video.totalFrames, window.__video.fps, window.__video.mesh.current && window.__video.mesh.current.count, !!(window.__video.index && window.__video.index.cadrage), window.__video.duration.toFixed(2)]")
            page.screenshot(path=os.path.join(ICI, "sortie", "src_" + nom.replace(" ", "_") + ".png"))
            print(f"{nom:18} {etat[:110]:12} ({time.time() - t0:4.1f} s) | séquences {info[0]}, images {info[1]}, {info[2]} i/s, gaussiennes {info[3]}, cadrage {info[4]}, durée {info[5]} s"
                  + (f" | erreurs {[e[:160] for e in err if '__etat' not in e][:2]}" if err else ""))
            ctx.close()
        b.close()
finally:
    serveur.terminate()
