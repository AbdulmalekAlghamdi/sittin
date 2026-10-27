"""Build index.html (GitHub Pages) and artifact.html from ui.html + tq-core.js.

Usage: python3 build.py
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MB_MARK = "<!--__MEDIABUNNY__-->"
HEAD = (
    '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);'
    'padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}'
    '[hidden]{display:none!important}</style>\n'
)


def main() -> None:
    core = (ROOT / "tq-core.js").read_text(encoding="utf-8")
    base = (ROOT / "ui.html").read_text(encoding="utf-8").replace("/*__TQ_CORE__*/", core)
    # Artifact: scripts may only come from allowlisted CDNs, so the library is inlined.
    lib = (ROOT / "mediabunny.min.js").read_text(encoding="utf-8")
    (ROOT / "artifact.html").write_text(base.replace(MB_MARK, "<script>\n" + lib + "\n</script>"), encoding="utf-8")
    # GitHub Pages: served from the repo itself (jsDelivr sends .cjs as application/node, which browsers refuse to run).
    ui = base.replace(MB_MARK, '<script src="mediabunny.min.js"></script>')
    split = ui.index('<div class="app"')
    page = HEAD + ui[:split] + "</head>\n<body>\n" + ui[split:] + "\n</body>\n</html>\n"
    (ROOT / "index.html").write_text(page, encoding="utf-8")
    print("built index.html and artifact.html")


if __name__ == "__main__":
    main()
