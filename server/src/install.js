// Page d'aide pour installer l'autorité de certification sur un téléphone / une tablette (une seule fois).
const page = (httpsPort) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Installer la caisse</title>
<style>
 body{font-family:system-ui,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;margin:0;background:#f1f5f9;color:#0f172a;line-height:1.5}
 main{max-width:640px;margin:0 auto;padding:16px}
 .card{background:#fff;border-radius:16px;padding:16px;margin:12px 0;box-shadow:0 1px 3px #0002}
 a.btn{display:block;text-align:center;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;padding:16px;border-radius:12px;font-size:18px}
 h1{font-size:22px} h2{font-size:17px;margin:0 0 6px} ol{padding-inline-start:20px;margin:6px 0}
 .ar{direction:rtl;text-align:right}
</style></head><body><main>
<h1>🛒 Installer la caisse sur cet appareil</h1>
<p>À faire <b>une seule fois</b> par téléphone ou tablette. Cela permet d'utiliser la caméra (scan de codes-barres) et le mode hors-ligne.</p>
<div class="card"><h2>Étape 1 — Télécharger le certificat</h2><a class="btn" href="/ca.crt">⬇ Télécharger le certificat</a></div>
<div class="card"><h2>Étape 2 — L'installer</h2>
 <p><b>Android</b></p>
 <ol><li>Ouvrir <i>Paramètres → Sécurité (et confidentialité) → Plus de paramètres → Chiffrement et identifiants → Installer un certificat → Certificat CA</i>.</li>
 <li>Choisir « Installer quand même », puis sélectionner le fichier téléchargé <i>caisse-ca.crt</i>.</li></ol>
 <p><b>iPhone / iPad</b></p>
 <ol><li>Autoriser le téléchargement du profil, puis <i>Réglages → Profil téléchargé → Installer</i>.</li>
 <li>Puis <i>Réglages → Général → Informations → Réglages des certificats → activer</i> « Caisse Magasin ».</li></ol>
</div>
<div class="card"><h2>Étape 3 — Ouvrir la caisse en sécurisé</h2>
 <a class="btn" id="go" href="#">Ouvrir la caisse (HTTPS)</a>
 <p style="font-size:14px;color:#475569">Ensuite : menu du navigateur → « Ajouter à l'écran d'accueil ».</p></div>
<div class="card ar"><h2>بالعربية</h2>
 <p>تُنفَّذ هذه الخطوات <b>مرة واحدة</b> على كل هاتف أو جهاز لوحي: (1) حمّل الشهادة، (2) ثبّتها من إعدادات الأمان (أندرويد: «تثبيت شهادة ← شهادة CA»، آيفون: «الملف الشخصي المُنزَّل» ثم «إعدادات الشهادات»)، (3) افتح الصندوق عبر الزر الأخضر. بعد ذلك تعمل الكاميرا والوضع دون اتصال.</p></div>
<script>document.getElementById('go').href='https://'+location.hostname+':${httpsPort}/'</script>
</main></body></html>`;

export default async function install(app, { caPem, httpsPort }) {
  app.get('/install', async (req, reply) => reply.type('text/html; charset=utf-8').send(page(httpsPort)));
  app.get('/ca.crt', async (req, reply) =>
    reply.type('application/x-x509-ca-cert').header('Content-Disposition', 'attachment; filename="caisse-ca.crt"').send(caPem));
}
