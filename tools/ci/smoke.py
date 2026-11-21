"""Browser smoke test (GitHub Actions): serve the site, turn on the smart model, check a few photos.
Prints scene detection + look score per photo and any console errors; exits 1 on page errors."""
import asyncio, glob, sys, subprocess, time, pathlib
from playwright.async_api import async_playwright
ROOT = pathlib.Path(__file__).resolve().parents[2]

async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    errs, bad = [], False
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page(viewport={"width": 400, "height": 860})
            pg.on("pageerror", lambda e: errs.append("PAGEERROR " + str(e)))
            pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
            await pg.goto("http://localhost:8765/")
            await pg.click("nav button[data-tab=check]")
            t = time.time()
            await pg.locator("#check .smartBtn").click()
            await pg.wait_for_function("document.querySelector('#check .smartStatus').textContent.startsWith('Smart model on') || document.querySelector('#check .smartStatus').textContent.includes('failed')", timeout=600000)
            status = await pg.locator("#check .smartStatus").inner_text()
            print(f"smart model: {status} ({time.time() - t:.0f}s)")
            if "failed" in status: bad = True
            photos = sorted(glob.glob(str(ROOT / "refs/beach/*.jpg")))[:4] + sorted(glob.glob(str(ROOT / "tests/fixtures/*")))
            photos += sorted(glob.glob(str(ROOT / "data/train/*/*.jpg")))[::97][:12]
            for f in photos:
                await pg.set_input_files("#checkInput", f)
                await pg.wait_for_function("!document.querySelector('#checkResult').textContent.includes('Analyzing')", timeout=120000)
                txt = (await pg.inner_text("#checkResult")).replace("\n", " / ")
                print(f"- {pathlib.Path(f).parent.name}/{pathlib.Path(f).name}: {txt[:260]}")
            await pg.screenshot(path=str(ROOT / "smoke.png"), full_page=True)
            await b.close()
    finally:
        srv.terminate()
    print("console errors:", errs[:10])
    if bad or any(e.startswith("PAGEERROR") for e in errs): sys.exit(1)

asyncio.run(main())
