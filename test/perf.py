#!/usr/bin/env python3
"""Performance run in headless Chromium (SwiftShader: CPU only, the frame rate is NOT representative of a GPU;
   the worker timings are).  python3 test/perf.py data/coucou.4dgs nom [w h]"""
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ICI = os.path.dirname(os.path.abspath(__file__)); RACINE = os.path.dirname(ICI)
src, nom = sys.argv[1], sys.argv[2]
w, h = (sys.argv[3], sys.argv[4]) if len(sys.argv) > 4 else ("640", "360")
serveur = subprocess.Popen([sys.executable, os.path.join(RACINE, "tools/serve.py"), "8771"], cwd=RACINE,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("CHROME") or None,
                              args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": int(w), "height": int(h)})
        page.goto(f"http://127.0.0.1:8771/test/perf.html?src={src}&nom={nom}&w={w}&h={h}&s=6")
        page.wait_for_function("window.__perf", timeout=300000)
        print(json.dumps(page.evaluate("window.__perf"), indent=1, ensure_ascii=False))
        b.close()
finally:
    serveur.terminate()
