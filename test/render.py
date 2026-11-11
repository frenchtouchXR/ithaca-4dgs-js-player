#!/usr/bin/env python3
"""Headless render test (Chromium + SwiftShader WebGL2): screenshots and timings.
   python3 test/render.py data/coucou.4dgs [time_s] [nom]"""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright
ICI = os.path.dirname(os.path.abspath(__file__)); RACINE = os.path.dirname(ICI)
src = sys.argv[1] if len(sys.argv) > 1 else "data/coucou.4dgs"
temps = sys.argv[2] if len(sys.argv) > 2 else ""
nom = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(src).split(".")[0]
cam = os.environ.get("CAM", "")
serveur = subprocess.Popen([sys.executable, os.path.join(RACINE, "tools/serve.py"), "8771"], cwd=RACINE,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
os.makedirs(os.path.join(ICI, "sortie"), exist_ok=True)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME') or None, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 960, "height": 720})
        journal = []
        page.on("console", lambda m: journal.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: journal.append(f"pageerror: {e}"))
        url = f"http://127.0.0.1:8771/test/index.html?src={src}" + (f"&time={temps}&play=0" if temps else "") + (f"&cam={cam}" if cam else "")
        t0 = time.time()
        page.goto(url)
        page.wait_for_function("window.__etat !== 'load'", timeout=120000)
        etat = page.evaluate("window.__etat")
        print("état :", etat, f"({time.time() - t0:.1f} s)")
        if os.environ.get("JS"): print("JS :", page.evaluate(os.environ["JS"]))
        page.wait_for_timeout(1500)
        page.evaluate("window.__fps()")
        page.wait_for_timeout(3000)
        print("images/s (SwiftShader, logiciel) :", round(page.evaluate("window.__fps()"), 1))
        print("gaussiennes dessinées :", page.evaluate("window.__video.mesh.geometry.instanceCount"),
              "/", page.evaluate("window.__video.mesh.current && window.__video.mesh.current.count"))
        sortie = os.path.join(ICI, "sortie", f"{nom}{'_' + temps if temps else ''}.png")
        page.screenshot(path=sortie)
        print("capture :", sortie)
        vus = [l for l in journal if "useProgram" not in l]
        for l in vus[:12]: print("  ", l[:3000])
        b.close()
finally:
    serveur.terminate()
