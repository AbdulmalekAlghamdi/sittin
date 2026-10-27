# ستّين — Sittin

موقع يجهّز فيديوهات H.264 عشان تترفع على تيك توك بـ60 فريم وجودة 1080p.
كل المعالجة تصير داخل المتصفح، والفيديو ما يطلع من جهاز المستخدم.

## الملفات
- `index.html` — الموقع كامل في ملف واحد (يشتغل على GitHub Pages مباشرة).
- `tq-core.js` — نسخة جافاسكربت من أداة tiktok-quality (تُدمج داخل index.html).
- `mediabunny.min.js` — مكتبة التحويل داخل المتصفح (Mediabunny 1.61.3، رخصة MPL-2.0).
- `ui.html` + `build.py` — مصدر الصفحة. بعد أي تعديل: `python3 build.py`.

## النشر على GitHub Pages
1. ارفع الملفات لريبو جديد.
2. Settings ← Pages ← Source: `main` / root.
3. الرابط يطلع بالشكل: `https://<username>.github.io/<repo>/`

## الترخيص
مبني على [tiktok-quality](https://github.com/BastienGimbert/tiktok-quality) — MIT License © Bastien Gimbert.
النسخة هنا تعطي نفس المخرجات بايت ببايت.
التحويل يستخدم [Mediabunny](https://github.com/Vanilagy/mediabunny) — MPL-2.0 © Vanilagy and contributors.
غير تابع لتيك توك ولا ByteDance.
